import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { HttpError } from "@/lib/domain/errors";
import { accessIdentifier, auditAccess, readAdminProfile, requireAccessVersion } from "./admin-access";

type ClientUpdate = { name?: string; active?: boolean; portalEnabled?: boolean; usesSample?: boolean; expectedVersion?: number };

const CLIENT_NAME_CLAIMS_COLLECTION = "clientNameClaims";

type NormalizedClientName = {
  name: string;
  nameUpper: string;
};

type ClientNameClaimState = {
  newClaimRef: FirebaseFirestore.DocumentReference;
  oldClaimRef: FirebaseFirestore.DocumentReference | null;
  newClaimOwnerId: string | null;
  oldClaimOwnerId: string | null;
  conflictsWithLegacyClient: boolean;
};

function normalizeClientName(name: string): NormalizedClientName {
  const trimmed = name.trim();

  if (!trimmed) {
    throw new HttpError(400, "Nome do cliente é obrigatório.");
  }

  return {
    name: trimmed,
    nameUpper: trimmed.toUpperCase()
  };
}

function clientNameClaimRef(nameUpper: string) {
  const claimId = createHash("sha256").update(nameUpper).digest("hex");
  return adminDb.collection(CLIENT_NAME_CLAIMS_COLLECTION).doc(claimId);
}

async function readClientNameClaimState(params: {
  transaction: FirebaseFirestore.Transaction;
  clientId: string;
  oldNameUpper: string;
  normalized: NormalizedClientName;
}): Promise<ClientNameClaimState> {
  const newClaimRef = clientNameClaimRef(params.normalized.nameUpper);
  const oldClaimRef = params.oldNameUpper
    ? clientNameClaimRef(params.oldNameUpper)
    : null;
  const newClaim = await params.transaction.get(newClaimRef);
  const duplicates = await params.transaction.get(
    adminDb
      .collection("clients")
      .where("nameUpper", "==", params.normalized.nameUpper)
      .limit(2)
  );
  const oldClaim =
    oldClaimRef && oldClaimRef.path !== newClaimRef.path
      ? await params.transaction.get(oldClaimRef)
      : newClaim;

  return {
    newClaimRef,
    oldClaimRef,
    newClaimOwnerId: newClaim.exists
      ? String(newClaim.data()?.clientId || "")
      : null,
    oldClaimOwnerId: oldClaim?.exists
      ? String(oldClaim.data()?.clientId || "")
      : null,
    conflictsWithLegacyClient: duplicates.docs.some(
      (doc) => doc.id !== params.clientId
    )
  };
}

function assertClientNameAvailable(
  state: ClientNameClaimState,
  clientId: string
): void {
  if (
    (state.newClaimOwnerId !== null &&
      state.newClaimOwnerId !== clientId) ||
    state.conflictsWithLegacyClient
  ) {
    throw new HttpError(409, "Cliente já cadastrado.");
  }
}

function updateClientNameClaims(params: {
  transaction: FirebaseFirestore.Transaction;
  state: ClientNameClaimState;
  normalized: NormalizedClientName;
  clientId: string;
}): void {
  params.transaction.set(
    params.state.newClaimRef,
    {
      clientId: params.clientId,
      nameUpper: params.normalized.nameUpper,
      updatedAt: FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  const oldClaimRef = params.state.oldClaimRef;
  if (
    oldClaimRef &&
    oldClaimRef.path !== params.state.newClaimRef.path &&
    params.state.oldClaimOwnerId === params.clientId
  ) {
    params.transaction.delete(oldClaimRef);
  }
}

function buildClientUpdates(params: {
  payload: ClientUpdate;
  normalized: NormalizedClientName | null;
  actorUid: string;
}): Record<string, unknown> {
  return {
    ...(params.normalized
      ? {
          name: params.normalized.name,
          nameUpper: params.normalized.nameUpper
        }
      : {}),
    ...(typeof params.payload.active === "boolean"
      ? { active: params.payload.active }
      : {}),
    ...(typeof params.payload.portalEnabled === "boolean" ? {portalEnabled: params.payload.portalEnabled} : {}),
    ...(typeof params.payload.usesSample === "boolean" ? {usesSample: params.payload.usesSample} : {}),
    updatedAt: FieldValue.serverTimestamp(),
    updatedByUid: params.actorUid
  };
}

export async function listClients(includeInactive: boolean) {
  let query = adminDb.collection("clients") as FirebaseFirestore.Query;

  if (!includeInactive) {
    query = query.where("active", "==", true);
  }

  const snap = await query.orderBy("nameUpper", "asc").get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data(), accessVersion: doc.data().accessVersion ?? 0,
    portalEnabled: doc.data().portalEnabled === true, usesSample: doc.data().usesSample !== false }));
}

export async function createClient(name: string, actorUid: string) {
  const normalized = normalizeClientName(name);
  const ref = adminDb.collection("clients").doc();
  const claimRef = clientNameClaimRef(normalized.nameUpper);

  await adminDb.runTransaction(async (transaction) => {
    await readAdminProfile(transaction, actorUid);
    const [claim, legacyDuplicates] = await Promise.all([
      transaction.get(claimRef),
      transaction.get(
        adminDb
          .collection("clients")
          .where("nameUpper", "==", normalized.nameUpper)
          .limit(1)
      )
    ]);

    if (claim.exists || !legacyDuplicates.empty) {
      throw new HttpError(409, "Cliente já cadastrado.");
    }

    transaction.create(claimRef, {
      clientId: ref.id,
      nameUpper: normalized.nameUpper,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
    transaction.create(ref, {
      name: normalized.name,
      nameUpper: normalized.nameUpper,
      active: true,
      portalEnabled: false,
      usesSample: true,
      accessVersion: 0,
      createdAt: FieldValue.serverTimestamp(),
      createdByUid: actorUid,
      updatedAt: FieldValue.serverTimestamp(),
      updatedByUid: actorUid
    });
    auditAccess(transaction, {target: ref.path, actorUid, action: "CLIENT_CREATED", before: null,
      after: {name: normalized.name, active: true, portalEnabled: false, usesSample: true}, previousVersion: 0, newVersion: 0});
  });

  const snap = await ref.get();
  return { id: snap.id, ...snap.data() };
}

export async function updateClient(
  clientId: string,
  payload: ClientUpdate,
  actorUid: string
) {
  const ref = adminDb.collection("clients").doc(accessIdentifier.parse(clientId));
  const normalized =
    typeof payload.name === "string"
      ? normalizeClientName(payload.name)
      : null;

  await adminDb.runTransaction(async (transaction) => {
    await readAdminProfile(transaction, actorUid);
    const snap = await transaction.get(ref);

    if (!snap.exists) {
      throw new HttpError(404, "Cliente não encontrado.");
    }

    const existing = snap.data() ?? {};
    const version = requireAccessVersion(existing.accessVersion, payload.expectedVersion);
    if (normalized) {
      const claimState = await readClientNameClaimState({
        transaction,
        clientId,
        oldNameUpper: String(existing.nameUpper || ""),
        normalized
      });
      assertClientNameAvailable(claimState, clientId);
      updateClientNameClaims({
        transaction,
        state: claimState,
        normalized,
        clientId
      });
    }

    const patch = buildClientUpdates({ payload, normalized, actorUid });
    transaction.update(ref, {...patch, accessVersion: version + 1});
    const before = {name: existing.name, active: existing.active, portalEnabled: existing.portalEnabled === true, usesSample: existing.usesSample !== false};
    auditAccess(transaction, {target: ref.path, actorUid, action: "CLIENT_UPDATED", before,
      after: {name: normalized?.name ?? before.name, active: payload.active ?? before.active,
        portalEnabled: payload.portalEnabled ?? before.portalEnabled, usesSample: payload.usesSample ?? before.usesSample},
      previousVersion: version, newVersion: version + 1});
  });

  const updated = await ref.get();
  return { id: updated.id, ...updated.data() };
}
