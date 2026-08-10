import "server-only";

import { createHash } from "node:crypto";
import { HttpError } from "@/lib/domain/errors";
import { adminDb } from "@/lib/firebase/admin";

const COLLECTION = "_checkinIntegrationRequests";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TOKEN_PATTERN = /^[A-Z0-9_.:-]{1,80}$/i;
const SAFE_ENVELOPE_KEYS = new Set([
  "success",
  "code",
  "publicCode",
  "publicStatus",
  "syncState",
  "recovered",
  "version",
  "examined",
  "expired",
  "hasMore"
]);

export type CheckinReplaySafeEnvelope = {
  success: boolean;
  code?: string;
  publicCode?: string;
  publicStatus?: string;
  syncState?: string;
  recovered?: boolean;
  version?: number;
  examined?: number;
  expired?: number;
  hasMore?: boolean;
};

type ReplayDocumentReference = { id: string };
type ReplayDocumentSnapshot = {
  exists: boolean;
  data(): Record<string, unknown> | undefined;
};
type ReplayTransaction = {
  get(reference: ReplayDocumentReference): Promise<ReplayDocumentSnapshot>;
  set(reference: ReplayDocumentReference, data: Record<string, unknown>): void;
};

/** Minimal Firestore surface kept injectable so concurrency invariants are unit-testable. */
export type CheckinReplayStore = {
  collection(name: string): { doc(id: string): ReplayDocumentReference };
  runTransaction<T>(callback: (transaction: ReplayTransaction) => Promise<T>): Promise<T>;
};

type ReplayIdentity = {
  requestId: string;
  bodyHash: string;
  operation: string;
  nowIso: string;
};

export type CheckinReplayReservation =
  | { kind: "reserved"; attempt: number }
  | {
      kind: "completed";
      httpStatus: number;
      envelope: CheckinReplaySafeEnvelope;
    };

type StoredReplayRequest = ReplayIdentity & {
  state: "PROCESSING" | "COMPLETED" | "FAILED";
  attempt: number;
  createdAt: string;
  updatedAt: string;
  processingStartedAt: string;
  completedAt?: string;
  failedAt?: string;
  errorCode?: string;
  httpStatus?: number;
  envelope?: CheckinReplaySafeEnvelope;
};

const defaultStore = adminDb as unknown as CheckinReplayStore;

function genericConflict(): HttpError {
  // Deliberately identical for body mismatch and in-flight replay to avoid an oracle.
  return new HttpError(409, "Requisição já utilizada.", { code: "CONFLICT" });
}

function validateIdentity(input: ReplayIdentity): void {
  if (!UUID_PATTERN.test(input.requestId)) {
    throw new HttpError(400, "Identificador da requisição inválido.");
  }
  if (!SHA256_PATTERN.test(input.bodyHash)) {
    throw new HttpError(400, "Hash da requisição inválido.");
  }
  if (!TOKEN_PATTERN.test(input.operation)) {
    throw new HttpError(400, "Operação da requisição inválida.");
  }
  if (!Number.isFinite(Date.parse(input.nowIso))) {
    throw new HttpError(400, "Horário da requisição inválido.");
  }
}

function assertSameIdentity(stored: StoredReplayRequest, input: ReplayIdentity): void {
  if (stored.bodyHash !== input.bodyHash || stored.operation !== input.operation) {
    throw genericConflict();
  }
}

function parseStoredDocument(value: Record<string, unknown> | undefined): StoredReplayRequest {
  if (!value || !UUID_PATTERN.test(String(value.requestId || ""))) {
    throw genericConflict();
  }
  return value as StoredReplayRequest;
}

function assertSafeEnvelope(value: CheckinReplaySafeEnvelope): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Envelope seguro inválido.");
  }
  if (typeof value.success !== "boolean") {
    throw new HttpError(400, "Envelope seguro inválido.");
  }

  for (const [key, fieldValue] of Object.entries(value)) {
    if (!SAFE_ENVELOPE_KEYS.has(key)) {
      throw new HttpError(400, "Envelope seguro contém campo não permitido.");
    }
    if (
      (key === "recovered" || key === "hasMore") &&
      typeof fieldValue !== "boolean"
    ) {
      throw new HttpError(400, "Envelope seguro inválido.");
    }
    if (
      key === "version" &&
      (!Number.isSafeInteger(fieldValue) || Number(fieldValue) <= 0)
    ) {
      throw new HttpError(400, "Envelope seguro inválido.");
    }
    if (
      (key === "examined" || key === "expired") &&
      (!Number.isSafeInteger(fieldValue) || Number(fieldValue) < 0)
    ) {
      throw new HttpError(400, "Envelope seguro inválido.");
    }
    if (
      key !== "success" &&
      key !== "recovered" &&
      key !== "version" &&
      key !== "examined" &&
      key !== "expired" &&
      key !== "hasMore" &&
      (typeof fieldValue !== "string" || fieldValue.length > 100)
    ) {
      throw new HttpError(400, "Envelope seguro inválido.");
    }
  }
}

export function hashCheckinIntegrationBody(rawBody: string): string {
  return createHash("sha256").update(rawBody, "utf8").digest("hex");
}

export async function reserveCheckinIntegrationRequest(
  input: ReplayIdentity,
  store: CheckinReplayStore = defaultStore
): Promise<CheckinReplayReservation> {
  validateIdentity(input);
  const reference = store.collection(COLLECTION).doc(input.requestId);

  return store.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) {
      transaction.set(reference, {
        requestId: input.requestId,
        bodyHash: input.bodyHash,
        operation: input.operation,
        state: "PROCESSING",
        attempt: 1,
        createdAt: input.nowIso,
        updatedAt: input.nowIso,
        processingStartedAt: input.nowIso
      });
      return { kind: "reserved", attempt: 1 };
    }

    const stored = parseStoredDocument(snapshot.data());
    assertSameIdentity(stored, input);

    if (stored.state === "COMPLETED") {
      if (!stored.envelope || !Number.isInteger(stored.httpStatus)) {
        throw genericConflict();
      }
      assertSafeEnvelope(stored.envelope);
      return {
        kind: "completed",
        httpStatus: stored.httpStatus as number,
        envelope: stored.envelope
      };
    }

    if (stored.state === "PROCESSING") {
      throw genericConflict();
    }

    const attempt = stored.attempt + 1;
    // A FAILED document is the only explicit retry gate; replacing it clears error metadata.
    transaction.set(reference, {
      requestId: stored.requestId,
      bodyHash: stored.bodyHash,
      operation: stored.operation,
      state: "PROCESSING",
      attempt,
      createdAt: stored.createdAt,
      updatedAt: input.nowIso,
      processingStartedAt: input.nowIso
    });
    return { kind: "reserved", attempt };
  });
}

export async function completeCheckinIntegrationRequest(
  input: ReplayIdentity & {
    httpStatus: number;
    envelope: CheckinReplaySafeEnvelope;
  },
  store: CheckinReplayStore = defaultStore
): Promise<void> {
  validateIdentity(input);
  if (!Number.isInteger(input.httpStatus) || input.httpStatus < 100 || input.httpStatus > 599) {
    throw new HttpError(400, "Status HTTP da resposta inválido.");
  }
  assertSafeEnvelope(input.envelope);
  const reference = store.collection(COLLECTION).doc(input.requestId);

  await store.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const stored = parseStoredDocument(snapshot.data());
    assertSameIdentity(stored, input);
    if (stored.state !== "PROCESSING") {
      throw genericConflict();
    }

    // Only the allow-listed envelope is persisted; raw request/response bodies and PII are not.
    transaction.set(reference, {
      requestId: stored.requestId,
      bodyHash: stored.bodyHash,
      operation: stored.operation,
      state: "COMPLETED",
      attempt: stored.attempt,
      createdAt: stored.createdAt,
      processingStartedAt: stored.processingStartedAt,
      updatedAt: input.nowIso,
      completedAt: input.nowIso,
      httpStatus: input.httpStatus,
      envelope: { ...input.envelope }
    });
  });
}

export async function failCheckinIntegrationRequest(
  input: ReplayIdentity & { errorCode: string },
  store: CheckinReplayStore = defaultStore
): Promise<void> {
  validateIdentity(input);
  if (!TOKEN_PATTERN.test(input.errorCode)) {
    throw new HttpError(400, "Código de falha inválido.");
  }
  const reference = store.collection(COLLECTION).doc(input.requestId);

  await store.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const stored = parseStoredDocument(snapshot.data());
    assertSameIdentity(stored, input);
    if (stored.state !== "PROCESSING") {
      throw genericConflict();
    }

    transaction.set(reference, {
      requestId: stored.requestId,
      bodyHash: stored.bodyHash,
      operation: stored.operation,
      state: "FAILED",
      attempt: stored.attempt,
      createdAt: stored.createdAt,
      processingStartedAt: stored.processingStartedAt,
      updatedAt: input.nowIso,
      failedAt: input.nowIso,
      errorCode: input.errorCode
    });
  });
}
