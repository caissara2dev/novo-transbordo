import "server-only";

import { adminDb } from "@/lib/firebase/admin";
import { HttpError } from "@/lib/domain/errors";
import { isPreRegistrationExpired } from "@/lib/domain/checkins";
import type { StoredCheckin } from "@/types/checkins";

const CHECKINS_COLLECTION = "checkins";
const UNIQUE_LOCKS_COLLECTION = "_checkinUniqueLocks";
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 250;
const PRE_REGISTRATION_TTL_MS = 5 * 24 * 60 * 60 * 1_000;

function requireNow(value: string): number {
  const nowMs = Date.parse(value);
  if (!Number.isFinite(nowMs)) {
    throw new HttpError(400, "Horário da expiração inválido.");
  }
  return nowMs;
}

function requireLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_PAGE_SIZE) {
    throw new HttpError(400, "Limite da expiração inválido.");
  }
  return limit;
}

function identityLockRef(kind: "cnh" | "plate", index: string) {
  return adminDb
    .collection(UNIQUE_LOCKS_COLLECTION)
    .doc(`${kind}_${index.replace(":", "_")}`);
}

async function expireCandidate(checkinId: string, nowIso: string): Promise<boolean> {
  const checkinRef = adminDb.collection(CHECKINS_COLLECTION).doc(checkinId);

  return adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(checkinRef);
    const stored = snapshot.data() as StoredCheckin | undefined;
    if (
      !snapshot.exists ||
      !stored ||
      // A durable Excel-backed reservation serializes this visit until commit/retry.
      Boolean(stored.pendingOfficialMutation) ||
      // A public Excel command may have succeeded even when its response was lost.
      (stored.status === "PRE_CADASTRO" && stored.syncState !== null) ||
      !isPreRegistrationExpired({
        status: stored.status,
        createdAtIso: stored.createdAtIso,
        nowIso
      })
    ) {
      return false;
    }

    const nextVersion = stored.version + 1;
    transaction.update(checkinRef, {
      status: "CANCELADO",
      cancellationReason: "EXPIRADO",
      syncState: null,
      version: nextVersion,
      updatedAtIso: nowIso
    });
    transaction.delete(identityLockRef("cnh", stored.driverLicenseIndex));
    transaction.delete(identityLockRef("plate", stored.plateIndex));
    transaction.create(checkinRef.collection("revisions").doc(), {
      action: "PRE_REGISTRATION_EXPIRED",
      source: "SYSTEM",
      requestId: null,
      previousVersion: stored.version,
      newVersion: nextVersion,
      reason: "EXPIRADO",
      createdAtIso: nowIso
    });
    return true;
  });
}

/**
 * Runs one bounded sweep. The caller must schedule additional calls while
 * `hasMore` is true; the transaction rechecks the TTL so overlapping workers
 * remain safe and idempotent.
 */
export async function expireUnusedPreRegistrations(input: {
  nowIso: string;
  limit?: number;
}): Promise<{ examined: number; expired: number; hasMore: boolean }> {
  const nowMs = requireNow(input.nowIso);
  const limit = requireLimit(input.limit);
  const cutoffIso = new Date(nowMs - PRE_REGISTRATION_TTL_MS).toISOString();
  const snapshot = await adminDb
    .collection(CHECKINS_COLLECTION)
    .where("status", "==", "PRE_CADASTRO")
    .where("createdAtIso", "<=", cutoffIso)
    .limit(limit + 1)
    .get();
  const candidates = snapshot.docs.slice(0, limit);
  const results = await Promise.all(
    candidates.map((candidate) => expireCandidate(candidate.id, input.nowIso))
  );

  return {
    examined: candidates.length,
    expired: results.filter(Boolean).length,
    hasMore: snapshot.docs.length > limit
  };
}
