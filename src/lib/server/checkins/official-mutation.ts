import "server-only";

import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  isPreRegistrationExpired,
  validateDriverCheckinInput
} from "@/lib/domain/checkins";
import type { DriverCheckinForm } from "@/lib/domain/checkins";
import { HttpError } from "@/lib/domain/errors";
import { adminDb } from "@/lib/firebase/admin";
import type { InternalCheckinActor } from "@/lib/server/checkins/internal-service";
import type {
  PendingOfficialMutation,
  StoredCheckin
} from "@/types/checkins";

const CHECKINS_COLLECTION = "checkins";
const UNIQUE_LOCKS_COLLECTION = "_checkinUniqueLocks";
const MAX_REASON_LENGTH = 500;

type ManagedStoredCheckin = StoredCheckin & {
  clientId?: string | null;
  clientNameSnapshot?: string | null;
};

type ReservationBase = {
  token: string;
  publicCode: string;
  reservedVersion: number;
};

export type CorrectionReservation = ReservationBase & {
  kind: "CORRECTION";
  idempotencyKey: string;
  patch: Partial<DriverCheckinForm>;
};

export type LocationOverrideReservation = ReservationBase & {
  kind: "LOCATION_OVERRIDE";
  form: DriverCheckinForm;
};

const correctionFields = [
  "driverName",
  "driverLicense",
  "driverPhone",
  "plate",
  "carrierName",
  "vehicleType",
  "product",
  "originPlant",
  "originInvoiceNumbers",
  "remittanceInvoiceNumber",
  "whatsappNoticeAccepted",
  "queueLocationAccepted"
] as const satisfies ReadonlyArray<keyof DriverCheckinForm>;

function requireManager(actor: InternalCheckinActor) {
  const uid = actor.uid?.trim();
  if (!uid) throw new HttpError(401, "Usuário não autenticado.");
  if (actor.role !== "SUPERVISOR" && actor.role !== "ADMIN") {
    throw new HttpError(403, "Apenas Supervisor ou Admin pode executar esta ação.");
  }
  return { uid, role: actor.role };
}

function requireDocumentId(value: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > 128 || normalized.includes("/")) {
    throw new HttpError(400, "Identificador do check-in inválido.");
  }
  return normalized;
}

function requireVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new HttpError(400, "Versão esperada inválida.");
  }
  return value;
}

function requireReason(value: string, label = "Motivo"): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new HttpError(400, `${label} é obrigatório.`);
  if (normalized.length > MAX_REASON_LENGTH) {
    throw new HttpError(400, `${label} excede ${MAX_REASON_LENGTH} caracteres.`);
  }
  return normalized;
}

function requireIsoDate(value: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new HttpError(400, "Horário da operação inválido.");
  }
  return value;
}

function asStored(
  snapshot: FirebaseFirestore.DocumentSnapshot
): ManagedStoredCheckin {
  const stored = snapshot.data() as ManagedStoredCheckin | undefined;
  if (!snapshot.exists || !stored) {
    throw new HttpError(404, "Check-in não encontrado.");
  }
  return stored;
}

function formFromStored(stored: ManagedStoredCheckin): DriverCheckinForm {
  return validateDriverCheckinInput({
    driverName: stored.driverName,
    driverLicense: stored.driverLicense,
    driverPhone: stored.driverPhone,
    plate: stored.plate,
    carrierName: stored.carrierName,
    vehicleType: stored.vehicleType,
    product: stored.product,
    originPlant: stored.originPlant,
    originInvoiceNumbers: stored.originInvoiceNumbers,
    remittanceInvoiceNumber: stored.remittanceInvoiceNumber,
    whatsappNoticeAccepted: stored.whatsappNoticeAccepted,
    queueLocationAccepted: stored.queueLocationAccepted
  });
}

function normalizedPatch(
  stored: ManagedStoredCheckin,
  patch: Partial<DriverCheckinForm>
): Partial<DriverCheckinForm> {
  const supplied = Object.keys(patch) as Array<keyof DriverCheckinForm>;
  if (
    supplied.length === 0 ||
    supplied.some((field) => !correctionFields.includes(field))
  ) {
    throw new HttpError(400, "Campos de correção inválidos.");
  }
  const current = formFromStored(stored);
  const next = validateDriverCheckinInput({ ...current, ...patch });
  const changed = supplied
    .filter((field) => current[field] !== next[field])
    .map((field) => [field, next[field]] as const);
  if (changed.length === 0) {
    throw new HttpError(400, "A correção não altera nenhum campo.");
  }
  return Object.fromEntries(changed) as Partial<DriverCheckinForm>;
}

function payloadHash(payload: unknown): string {
  const stable = JSON.stringify(payload, Object.keys(payload as object).sort());
  return createHash("sha256").update(stable).digest("hex");
}

function requireHmacSecret(): string {
  const secret = process.env.CHECKIN_INDEX_HMAC_SECRET ?? "";
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new HttpError(500, "Configuração de identidade do check-in inválida.");
  }
  return secret;
}

function identityIndex(secret: string, namespace: string, value: string): string {
  return `v1:${createHmac("sha256", secret)
    .update(`${namespace}:${value}`)
    .digest("hex")}`;
}

function nextIndexes(stored: ManagedStoredCheckin, form: DriverCheckinForm) {
  if (
    form.driverLicense === stored.driverLicense &&
    form.driverPhone === stored.driverPhone &&
    form.plate === stored.plate
  ) {
    return {
      driverLicenseIndex: stored.driverLicenseIndex,
      driverPhoneIndex: stored.driverPhoneIndex,
      plateIndex: stored.plateIndex
    };
  }
  const secret = requireHmacSecret();
  return {
    driverLicenseIndex: identityIndex(secret, "cnh", form.driverLicense),
    driverPhoneIndex: identityIndex(secret, "phone", form.driverPhone),
    plateIndex: identityIndex(secret, "plate", form.plate)
  };
}

function lockRef(kind: "cnh" | "plate", index: string) {
  return adminDb
    .collection(UNIQUE_LOCKS_COLLECTION)
    .doc(`${kind}_${index.replace(":", "_")}`);
}

function isActiveVisit(stored: ManagedStoredCheckin): boolean {
  return stored.status !== "CONCLUIDO" && stored.status !== "CANCELADO";
}

function revision(input: {
  action: string;
  actor: { uid: string; role: "SUPERVISOR" | "ADMIN" };
  reason: string;
  changedFields: string[];
  previousVersion: number;
  newVersion: number;
  createdAtIso: string;
  highlight?: "GPS_BYPASS";
}) {
  return {
    action: input.action,
    actorUid: input.actor.uid,
    actorRole: input.actor.role,
    reason: input.reason,
    changedFields: [...input.changedFields],
    previousVersion: input.previousVersion,
    newVersion: input.newVersion,
    createdAtIso: input.createdAtIso,
    ...(input.highlight ? { highlight: input.highlight } : {})
  };
}

function reusablePending(input: {
  stored: ManagedStoredCheckin;
  kind: PendingOfficialMutation["kind"];
  hash: string;
  expectedVersion: number;
}) {
  const pending = input.stored.pendingOfficialMutation;
  if (!pending) return null;
  if (
    input.stored.version !== input.expectedVersion ||
    pending.kind !== input.kind ||
    pending.payloadHash !== input.hash
  ) {
    throw new HttpError(
      409,
      "Existe uma sincronização oficial pendente. Repita a mesma operação ou aguarde a conclusão."
    );
  }
  return pending;
}

function correctionReservation(
  stored: ManagedStoredCheckin,
  pending: PendingOfficialMutation
): CorrectionReservation {
  if (pending.kind !== "CORRECTION" || !pending.patch) {
    throw new HttpError(500, "Comando oficial de correção inválido.");
  }
  return {
    kind: "CORRECTION",
    token: pending.token,
    publicCode: stored.publicCode,
    reservedVersion: pending.reservedVersion,
    idempotencyKey: `${stored.publicCode}:v${pending.reservedVersion}`,
    patch: { ...pending.patch }
  };
}

export async function reserveOfficialCorrection(input: {
  actor: InternalCheckinActor;
  checkinId: string;
  patch: Partial<DriverCheckinForm>;
  expectedVersion: number;
  reason: string;
  nowIso: string;
}): Promise<CorrectionReservation> {
  const actor = requireManager(input.actor);
  const checkinId = requireDocumentId(input.checkinId);
  const expectedVersion = requireVersion(input.expectedVersion);
  const reason = requireReason(input.reason);
  const nowIso = requireIsoDate(input.nowIso);
  const checkinRef = adminDb.collection(CHECKINS_COLLECTION).doc(checkinId);

  return adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(checkinRef);
    const stored = asStored(snapshot);
    if (stored.status === "PRE_CADASTRO") {
      throw new HttpError(409, "Este pré-cadastro ainda não possui linha oficial.");
    }
    const patch = normalizedPatch(stored, input.patch);
    const hash = payloadHash(patch);
    const reusable = reusablePending({ stored, kind: "CORRECTION", hash, expectedVersion });
    if (reusable) {
      transaction.update(checkinRef, {
        syncState: "EM_PROCESSAMENTO",
        pendingOfficialMutation: {
          ...reusable,
          state: "EM_PROCESSAMENTO",
          lastAttemptAtIso: nowIso
        },
        updatedAtIso: nowIso
      });
      return correctionReservation(stored, reusable);
    }
    if (stored.version !== expectedVersion) {
      throw new HttpError(409, "O check-in foi alterado. Atualize os dados e tente novamente.");
    }

    const form = validateDriverCheckinInput({ ...formFromStored(stored), ...patch });
    const indexes = nextIndexes(stored, form);
    const active = isActiveVisit(stored);
    const cnhChanged =
      active && indexes.driverLicenseIndex !== stored.driverLicenseIndex;
    const plateChanged = active && indexes.plateIndex !== stored.plateIndex;
    const cnhRef = cnhChanged ? lockRef("cnh", indexes.driverLicenseIndex) : null;
    const plateRef = plateChanged ? lockRef("plate", indexes.plateIndex) : null;
    const [cnhSnapshot, plateSnapshot] = await Promise.all([
      cnhRef ? transaction.get(cnhRef) : Promise.resolve(null),
      plateRef ? transaction.get(plateRef) : Promise.resolve(null)
    ]);
    if (
      (cnhSnapshot?.exists && cnhSnapshot.data()?.checkinId !== stored.id) ||
      (plateSnapshot?.exists && plateSnapshot.data()?.checkinId !== stored.id)
    ) {
      throw new HttpError(409, "Já existe uma visita ativa para os dados corrigidos.");
    }

    const reservedVersion = stored.version + 1;
    const pending: PendingOfficialMutation = {
      token: randomUUID(),
      kind: "CORRECTION",
      state: "EM_PROCESSAMENTO",
      payloadHash: hash,
      baseVersion: stored.version,
      reservedVersion,
      requestedByUid: actor.uid,
      requestedByRole: actor.role,
      reason,
      startedAtIso: nowIso,
      lastAttemptAtIso: nowIso,
      patch: { ...patch },
      nextIndexes: { ...indexes }
    };
    transaction.update(checkinRef, {
      pendingOfficialMutation: pending,
      syncState: "EM_PROCESSAMENTO",
      version: reservedVersion,
      updatedAtIso: nowIso
    });
    if (cnhRef) transaction.set(cnhRef, { kind: "CNH", checkinId, updatedAtIso: nowIso });
    if (plateRef) transaction.set(plateRef, { kind: "PLATE", checkinId, updatedAtIso: nowIso });
    transaction.create(
      checkinRef.collection("revisions").doc(),
      revision({
        action: "CHECKIN_CORRECTION_SYNC_STARTED",
        actor,
        reason,
        changedFields: Object.keys(patch),
        previousVersion: stored.version,
        newVersion: reservedVersion,
        createdAtIso: nowIso
      })
    );
    return correctionReservation(stored, pending);
  });
}

export async function commitOfficialCorrection(input: {
  checkinId: string;
  token: string;
  confirmedAtIso: string;
}): Promise<void> {
  const checkinId = requireDocumentId(input.checkinId);
  const confirmedAtIso = requireIsoDate(input.confirmedAtIso);
  const checkinRef = adminDb.collection(CHECKINS_COLLECTION).doc(checkinId);

  await adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(checkinRef);
    const stored = asStored(snapshot);
    const pending = stored.pendingOfficialMutation;
    if (
      !pending ||
      pending.kind !== "CORRECTION" ||
      pending.token !== input.token ||
      stored.version !== pending.reservedVersion
    ) {
      throw new HttpError(409, "A reserva da correção não é mais válida.");
    }
    const patch = pending.patch ?? {};
    const indexes = pending.nextIndexes;
    if (!indexes) throw new HttpError(500, "Índices reservados inválidos.");
    const changedFields = Object.keys(patch);
    const nextVersion = stored.version + 1;
    const cnhChanged = indexes.driverLicenseIndex !== stored.driverLicenseIndex;
    const plateChanged = indexes.plateIndex !== stored.plateIndex;
    transaction.update(checkinRef, {
      ...patch,
      ...indexes,
      pendingOfficialMutation: null,
      syncState: "CONFIRMADO",
      version: nextVersion,
      updatedAtIso: confirmedAtIso
    });
    if (cnhChanged) transaction.delete(lockRef("cnh", stored.driverLicenseIndex));
    if (plateChanged) transaction.delete(lockRef("plate", stored.plateIndex));
    transaction.create(
      checkinRef.collection("revisions").doc(),
      revision({
        action: "CHECKIN_CORRECTED",
        actor: {
          uid: pending.requestedByUid,
          role: pending.requestedByRole
        },
        reason: pending.reason,
        changedFields,
        previousVersion: stored.version,
        newVersion: nextVersion,
        createdAtIso: confirmedAtIso
      })
    );
  });
}

function locationReservation(
  stored: ManagedStoredCheckin,
  pending: PendingOfficialMutation
): LocationOverrideReservation {
  return {
    kind: "LOCATION_OVERRIDE",
    token: pending.token,
    publicCode: stored.publicCode,
    reservedVersion: pending.reservedVersion,
    form: formFromStored(stored)
  };
}

export async function reserveOfficialLocationOverride(input: {
  actor: InternalCheckinActor;
  checkinId: string;
  expectedVersion: number;
  justification: string;
  nowIso: string;
}): Promise<LocationOverrideReservation> {
  const actor = requireManager(input.actor);
  const checkinId = requireDocumentId(input.checkinId);
  const expectedVersion = requireVersion(input.expectedVersion);
  const justification = requireReason(input.justification, "Justificativa");
  const nowIso = requireIsoDate(input.nowIso);
  const hash = payloadHash({ justification });
  const checkinRef = adminDb.collection(CHECKINS_COLLECTION).doc(checkinId);

  return adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(checkinRef);
    const stored = asStored(snapshot);
    const reusable = reusablePending({
      stored,
      kind: "LOCATION_OVERRIDE",
      hash,
      expectedVersion
    });
    if (reusable) {
      transaction.update(checkinRef, {
        syncState: "EM_PROCESSAMENTO",
        pendingOfficialMutation: {
          ...reusable,
          state: "EM_PROCESSAMENTO",
          lastAttemptAtIso: nowIso
        },
        updatedAtIso: nowIso
      });
      return locationReservation(stored, reusable);
    }
    if (stored.version !== expectedVersion) {
      throw new HttpError(409, "O check-in foi alterado. Atualize os dados e tente novamente.");
    }
    if (stored.status !== "PRE_CADASTRO") {
      throw new HttpError(409, "Exceção de localização não permitida neste estado.");
    }
    if (
      isPreRegistrationExpired({
        status: stored.status,
        createdAtIso: stored.createdAtIso,
        nowIso
      })
    ) {
      // Reject before the external Excel call; the bounded sweep owns cancellation.
      throw new HttpError(410, "O pré-cadastro expirou e não pode ser confirmado.");
    }
    if (stored.syncState !== null) {
      throw new HttpError(
        409,
        "Já existe uma confirmação pública em processamento ou aguardando nova tentativa."
      );
    }

    const reservedVersion = stored.version + 1;
    const pending: PendingOfficialMutation = {
      token: randomUUID(),
      kind: "LOCATION_OVERRIDE",
      state: "EM_PROCESSAMENTO",
      payloadHash: hash,
      baseVersion: stored.version,
      reservedVersion,
      requestedByUid: actor.uid,
      requestedByRole: actor.role,
      reason: justification,
      startedAtIso: nowIso,
      lastAttemptAtIso: nowIso
    };
    transaction.update(checkinRef, {
      pendingOfficialMutation: pending,
      syncState: "EM_PROCESSAMENTO",
      version: reservedVersion,
      updatedAtIso: nowIso
    });
    transaction.create(
      checkinRef.collection("revisions").doc(),
      revision({
        action: "GPS_OVERRIDE_SYNC_STARTED",
        actor,
        reason: justification,
        changedFields: ["syncState", "locationOverride"],
        previousVersion: stored.version,
        newVersion: reservedVersion,
        createdAtIso: nowIso,
        highlight: "GPS_BYPASS"
      })
    );
    return locationReservation(stored, pending);
  });
}

export async function commitOfficialLocationOverride(input: {
  checkinId: string;
  token: string;
  confirmedAtIso: string;
}): Promise<void> {
  const checkinId = requireDocumentId(input.checkinId);
  const confirmedAtIso = requireIsoDate(input.confirmedAtIso);
  const checkinRef = adminDb.collection(CHECKINS_COLLECTION).doc(checkinId);

  await adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(checkinRef);
    const stored = asStored(snapshot);
    const pending = stored.pendingOfficialMutation;
    if (
      !pending ||
      pending.kind !== "LOCATION_OVERRIDE" ||
      pending.token !== input.token ||
      stored.version !== pending.reservedVersion ||
      stored.status !== "PRE_CADASTRO"
    ) {
      throw new HttpError(409, "A reserva da exceção de localização não é mais válida.");
    }
    const nextVersion = stored.version + 1;
    const locationOverride = {
      applied: true as const,
      justification: pending.reason,
      approvedByUid: pending.requestedByUid,
      approvedByRole: pending.requestedByRole,
      approvedAtIso: confirmedAtIso
    };
    transaction.update(checkinRef, {
      status: "AGUARDANDO_LIBERACAO",
      syncState: "CONFIRMADO",
      pendingOfficialMutation: null,
      locationOverride,
      confirmedAtIso,
      version: nextVersion,
      updatedAtIso: confirmedAtIso
    });
    transaction.create(
      checkinRef.collection("revisions").doc(),
      revision({
        action: "GPS_OVERRIDE_CONFIRMED",
        actor: {
          uid: pending.requestedByUid,
          role: pending.requestedByRole
        },
        reason: pending.reason,
        changedFields: ["status", "locationOverride"],
        previousVersion: stored.version,
        newVersion: nextVersion,
        createdAtIso: confirmedAtIso,
        highlight: "GPS_BYPASS"
      })
    );
  });
}

export async function markOfficialMutationFailure(input: {
  checkinId: string;
  token: string;
  failedAtIso: string;
}): Promise<void> {
  const checkinId = requireDocumentId(input.checkinId);
  const failedAtIso = requireIsoDate(input.failedAtIso);
  const checkinRef = adminDb.collection(CHECKINS_COLLECTION).doc(checkinId);

  await adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(checkinRef);
    const stored = asStored(snapshot);
    const pending = stored.pendingOfficialMutation;
    if (!pending || pending.token !== input.token) return;
    transaction.update(checkinRef, {
      syncState: "FALHA_RETRY",
      pendingOfficialMutation: {
        ...pending,
        state: "FALHA_RETRY",
        lastAttemptAtIso: failedAtIso
      },
      updatedAtIso: failedAtIso
    });
    transaction.create(checkinRef.collection("revisions").doc(), {
      action: "OFFICIAL_SYNC_FAILED",
      source: "SYSTEM",
      changedFields: ["syncState"],
      previousVersion: stored.version,
      newVersion: stored.version,
      createdAtIso: failedAtIso
    });
  });
}
