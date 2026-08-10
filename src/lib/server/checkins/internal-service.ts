import "server-only";

import { createHmac } from "node:crypto";
import { adminDb } from "@/lib/firebase/admin";
import {
  canTransitionCheckinStatus,
  checkinStatuses,
  validateDriverCheckinInput
} from "@/lib/domain/checkins";
import type {
  CheckinActorRole,
  CheckinStatus,
  DriverCheckinForm
} from "@/lib/domain/checkins";
import { HttpError } from "@/lib/domain/errors";
import type { UserRole } from "@/types/domain";
import type { StoredCheckin } from "@/types/checkins";

const CHECKINS_COLLECTION = "checkins";
const UNIQUE_LOCKS_COLLECTION = "_checkinUniqueLocks";
const MAX_LIST_RESULTS = 200;
const MAX_REASON_LENGTH = 500;

export type InternalCheckinActor = {
  uid: string;
  role: UserRole;
};

type LocationOverride = {
  applied: true;
  justification: string;
  approvedByUid: string;
  approvedByRole: "SUPERVISOR" | "ADMIN";
  approvedAtIso: string;
};

type InternalStoredCheckin = StoredCheckin & {
  clientId?: string | null;
  clientNameSnapshot?: string | null;
  locationOverride?: LocationOverride | null;
};

export type CheckinCorrectionPatch = Partial<DriverCheckinForm>;

export type OfficialRecordConfirmation = {
  confirmedAtIso: string;
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

function requireActor(actor: InternalCheckinActor): InternalCheckinActor {
  if (!actor.uid?.trim()) {
    throw new HttpError(401, "Usuário não autenticado.");
  }
  if (actor.role === "DISPLAY") {
    throw new HttpError(403, "Este perfil não pode acessar check-ins.");
  }
  return { uid: actor.uid.trim(), role: actor.role };
}

function requireManager(
  actor: InternalCheckinActor
): InternalCheckinActor & { role: "SUPERVISOR" | "ADMIN" } {
  const valid = requireActor(actor);
  if (valid.role !== "SUPERVISOR" && valid.role !== "ADMIN") {
    throw new HttpError(403, "Apenas Supervisor ou Admin pode executar esta ação.");
  }
  return valid as InternalCheckinActor & { role: "SUPERVISOR" | "ADMIN" };
}

function requireDocumentId(value: string, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > 128 || normalized.includes("/")) {
    throw new HttpError(400, `${label} inválido.`);
  }
  return normalized;
}

function requireReason(value: string, label = "Motivo"): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new HttpError(400, `${label} é obrigatório.`);
  }
  if (normalized.length > MAX_REASON_LENGTH) {
    throw new HttpError(400, `${label} excede ${MAX_REASON_LENGTH} caracteres.`);
  }
  return normalized;
}

function requireVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new HttpError(400, "Versão esperada inválida.");
  }
  return value;
}

function requireIsoDate(value: string, label = "Horário da operação"): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new HttpError(400, `${label} inválido.`);
  }
  return value;
}

function requireOfficialConfirmation(
  confirmation: OfficialRecordConfirmation | undefined
): string {
  const value = confirmation?.confirmedAtIso;
  if (!value || !Number.isFinite(Date.parse(value))) {
    throw new HttpError(
      409,
      "A alteração só pode ser concluída após a confirmação do registro oficial."
    );
  }
  return value;
}

function assertExpectedVersion(stored: InternalStoredCheckin, expected: number): void {
  if (stored.version !== expected) {
    throw new HttpError(409, "O check-in foi alterado. Atualize os dados e tente novamente.");
  }
}

function assertNoUnsettledOfficialSync(stored: InternalStoredCheckin): void {
  if (
    stored.pendingOfficialMutation ||
    (stored.status === "PRE_CADASTRO" && stored.syncState !== null)
  ) {
    throw new HttpError(
      409,
      "Existe uma sincronização oficial pendente. Repita a operação original ou aguarde a reconciliação."
    );
  }
}

function asStoredCheckin(
  snapshot: FirebaseFirestore.DocumentSnapshot
): InternalStoredCheckin {
  const data = snapshot.data() as InternalStoredCheckin | undefined;
  if (!snapshot.exists || !data) {
    throw new HttpError(404, "Check-in não encontrado.");
  }
  if (!checkinStatuses.includes(data.status)) {
    throw new HttpError(500, "Estado persistido do check-in é inválido.");
  }
  return data;
}

function operatorDto(stored: InternalStoredCheckin) {
  return {
    id: stored.id,
    plate: stored.plate,
    driverName: stored.driverName,
    carrierName: stored.carrierName,
    product: stored.product,
    clientId: stored.clientId ?? null,
    clientName: stored.clientNameSnapshot ?? null,
    status: stored.status,
    version: stored.version
  };
}

function managerDto(stored: InternalStoredCheckin) {
  return {
    ...operatorDto(stored),
    clientNameSnapshot: stored.clientNameSnapshot ?? null,
    publicCode: stored.publicCode,
    source: stored.source,
    syncState: stored.syncState,
    driverLicense: stored.driverLicense,
    driverPhone: stored.driverPhone,
    vehicleType: stored.vehicleType,
    originPlant: stored.originPlant,
    originInvoiceNumbers: stored.originInvoiceNumbers,
    remittanceInvoiceNumber: stored.remittanceInvoiceNumber,
    whatsappNoticeAccepted: stored.whatsappNoticeAccepted,
    queueLocationAccepted: stored.queueLocationAccepted,
    geofence: stored.geofence,
    locationOverride: stored.locationOverride ?? null,
    cancellationReason: stored.cancellationReason,
    activeProductiveEventId: stored.activeProductiveEventId ?? null,
    createdAtIso: stored.createdAtIso,
    updatedAtIso: stored.updatedAtIso,
    confirmedAtIso: stored.confirmedAtIso
  };
}

function revisionPayload(input: {
  action: string;
  actor: InternalCheckinActor;
  reason: string;
  changedFields: string[];
  previousVersion: number;
  newVersion: number;
  createdAtIso: string;
  fromStatus?: CheckinStatus;
  toStatus?: CheckinStatus;
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
    ...(input.fromStatus ? { fromStatus: input.fromStatus } : {}),
    ...(input.toStatus ? { toStatus: input.toStatus } : {}),
    ...(input.highlight ? { highlight: input.highlight } : {})
  };
}

function uniquenessLockRef(kind: "cnh" | "plate", index: string) {
  return adminDb
    .collection(UNIQUE_LOCKS_COLLECTION)
    .doc(`${kind}_${index.replace(":", "_")}`);
}

function releaseUniquenessLocks(
  transaction: FirebaseFirestore.Transaction,
  stored: InternalStoredCheckin
): void {
  transaction.delete(uniquenessLockRef("cnh", stored.driverLicenseIndex));
  transaction.delete(uniquenessLockRef("plate", stored.plateIndex));
}

function formFromStored(stored: InternalStoredCheckin): DriverCheckinForm {
  return {
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
    whatsappNoticeAccepted: true,
    queueLocationAccepted: true
  };
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

function correctionIndexes(
  stored: InternalStoredCheckin,
  form: DriverCheckinForm
): Pick<
  StoredCheckin,
  "driverLicenseIndex" | "driverPhoneIndex" | "plateIndex"
> {
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

function changedCorrectionFields(
  stored: InternalStoredCheckin,
  form: DriverCheckinForm,
  patch: CheckinCorrectionPatch
): Array<keyof DriverCheckinForm> {
  const suppliedKeys = Object.keys(patch);
  if (
    suppliedKeys.length === 0 ||
    suppliedKeys.some(
      (key) => !correctionFields.includes(key as keyof DriverCheckinForm)
    )
  ) {
    throw new HttpError(400, "Campos de correção inválidos.");
  }
  return correctionFields.filter(
    (field) => Object.hasOwn(patch, field) && stored[field] !== form[field]
  );
}

function isActiveVisit(status: CheckinStatus): boolean {
  return status !== "CANCELADO" && status !== "CONCLUIDO";
}

export async function listInternalCheckins(input: {
  actor: InternalCheckinActor;
  statuses?: CheckinStatus[];
}) {
  const actor = requireActor(input.actor);
  const requestedStatuses = input.statuses
    ? new Set(
        input.statuses.map((status) => {
          if (!checkinStatuses.includes(status)) {
            throw new HttpError(400, "Filtro de status inválido.");
          }
          return status;
        })
      )
    : null;
  const snapshot = await adminDb
    .collection(CHECKINS_COLLECTION)
    .orderBy("updatedAtIso", "desc")
    .limit(MAX_LIST_RESULTS)
    .get();
  const stored = snapshot.docs
    .map((document) => asStoredCheckin(document))
    .filter((checkin) => !requestedStatuses || requestedStatuses.has(checkin.status))
    .filter((checkin) => actor.role !== "OPERATOR" || checkin.status !== "PRE_CADASTRO");

  return actor.role === "OPERATOR"
    ? stored.map(operatorDto)
    : stored.map(managerDto);
}

export async function getInternalCheckin(input: {
  actor: InternalCheckinActor;
  checkinId: string;
}) {
  const actor = requireActor(input.actor);
  const checkinId = requireDocumentId(input.checkinId, "Identificador do check-in");
  const reference = adminDb.collection(CHECKINS_COLLECTION).doc(checkinId);
  const snapshot = await reference.get();
  const stored = asStoredCheckin(snapshot);

  if (actor.role === "OPERATOR") {
    if (stored.status === "PRE_CADASTRO") {
      throw new HttpError(404, "Check-in não encontrado.");
    }
    return operatorDto(stored);
  }

  const revisions = await reference
    .collection("revisions")
    .orderBy("createdAtIso", "desc")
    .limit(MAX_LIST_RESULTS)
    .get();
  return {
    ...managerDto(stored),
    revisions: revisions.docs.map((revision) => ({
      id: revision.id,
      ...revision.data()
    }))
  };
}

export async function assignInternalCheckinClient(input: {
  actor: InternalCheckinActor;
  checkinId: string;
  clientId: string;
  expectedVersion: number;
  reason: string;
  nowIso: string;
}) {
  const actor = requireManager(input.actor);
  const checkinId = requireDocumentId(input.checkinId, "Identificador do check-in");
  const clientId = requireDocumentId(input.clientId, "Cliente");
  const expectedVersion = requireVersion(input.expectedVersion);
  const reason = requireReason(input.reason);
  const nowIso = requireIsoDate(input.nowIso);
  const checkinRef = adminDb.collection(CHECKINS_COLLECTION).doc(checkinId);
  const clientRef = adminDb.collection("clients").doc(clientId);

  const updated = await adminDb.runTransaction(async (transaction) => {
    const [checkinSnapshot, clientSnapshot] = await Promise.all([
      transaction.get(checkinRef),
      transaction.get(clientRef)
    ]);
    const stored = asStoredCheckin(checkinSnapshot);
    assertExpectedVersion(stored, expectedVersion);
    assertNoUnsettledOfficialSync(stored);
    const client = clientSnapshot.data();
    if (!clientSnapshot.exists || client?.active !== true || !String(client.name ?? "").trim()) {
      throw new HttpError(400, "Selecione um cliente ativo.");
    }

    const nextVersion = stored.version + 1;
    const clientNameSnapshot = String(client.name).trim();
    const next: InternalStoredCheckin = {
      ...stored,
      clientId,
      clientNameSnapshot,
      version: nextVersion,
      updatedAtIso: nowIso
    };
    transaction.update(checkinRef, {
      clientId,
      clientNameSnapshot,
      version: nextVersion,
      updatedAtIso: nowIso
    });
    transaction.create(
      checkinRef.collection("revisions").doc(),
      revisionPayload({
        action: "CLIENT_ASSIGNED",
        actor,
        reason,
        changedFields: ["clientId"],
        previousVersion: stored.version,
        newVersion: nextVersion,
        createdAtIso: nowIso
      })
    );
    return next;
  });

  return managerDto(updated);
}

export async function transitionInternalCheckin(input: {
  actor: InternalCheckinActor;
  checkinId: string;
  toStatus: CheckinStatus;
  expectedVersion: number;
  reason: string;
  nowIso: string;
}) {
  const actor = requireManager(input.actor);
  const checkinId = requireDocumentId(input.checkinId, "Identificador do check-in");
  const expectedVersion = requireVersion(input.expectedVersion);
  const reason = requireReason(input.reason);
  const nowIso = requireIsoDate(input.nowIso);
  if (!checkinStatuses.includes(input.toStatus)) {
    throw new HttpError(400, "Status de destino inválido.");
  }
  const checkinRef = adminDb.collection(CHECKINS_COLLECTION).doc(checkinId);

  const updated = await adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(checkinRef);
    const stored = asStoredCheckin(snapshot);
    assertExpectedVersion(stored, expectedVersion);
    assertNoUnsettledOfficialSync(stored);
    if (
      !canTransitionCheckinStatus({
        role: actor.role as CheckinActorRole,
        from: stored.status,
        to: input.toStatus,
        trigger: "MANUAL"
      })
    ) {
      throw new HttpError(409, "Transição de status não permitida.");
    }
    if (input.toStatus === "AGUARDANDO_CHAMADA" && !stored.clientId) {
      throw new HttpError(409, "Atribua um cliente antes de liberar a chamada.");
    }
    if (
      stored.activeProductiveEventId &&
      (input.toStatus === "CHAMADO" || input.toStatus === "CANCELADO")
    ) {
      throw new HttpError(
        409,
        "Exclua o lançamento produtivo vinculado com um motivo antes de alterar este check-in.",
        { code: "CHECKIN_EVENT_MISMATCH" }
      );
    }

    const nextVersion = stored.version + 1;
    const clearsActiveEvent =
      stored.status === "EM_DESCARGA" && input.toStatus === "CONCLUIDO";
    const action =
      stored.status === "EM_DESCARGA" && input.toStatus === "CHAMADO"
        ? "PRODUCTIVE_SELECTION_REVERTED"
        : input.toStatus === "CANCELADO"
          ? "CHECKIN_CANCELLED"
          : "STATUS_CHANGED";
    const next: InternalStoredCheckin = {
      ...stored,
      status: input.toStatus,
      cancellationReason:
        input.toStatus === "CANCELADO" ? reason : stored.cancellationReason,
      activeProductiveEventId: clearsActiveEvent
        ? null
        : stored.activeProductiveEventId,
      version: nextVersion,
      updatedAtIso: nowIso
    };
    transaction.update(checkinRef, {
      status: next.status,
      cancellationReason: next.cancellationReason,
      ...(clearsActiveEvent ? { activeProductiveEventId: null } : {}),
      version: nextVersion,
      updatedAtIso: nowIso
    });
    if (input.toStatus === "CANCELADO" || input.toStatus === "CONCLUIDO") {
      releaseUniquenessLocks(transaction, stored);
    }
    transaction.create(
      checkinRef.collection("revisions").doc(),
      revisionPayload({
        action,
        actor,
        reason,
        changedFields: clearsActiveEvent
          ? ["status", "activeProductiveEventId"]
          : ["status"],
        previousVersion: stored.version,
        newVersion: nextVersion,
        createdAtIso: nowIso,
        fromStatus: stored.status,
        toStatus: input.toStatus
      })
    );
    return next;
  });

  return managerDto(updated);
}

export async function cancelInternalCheckin(input: {
  actor: InternalCheckinActor;
  checkinId: string;
  expectedVersion: number;
  reason: string;
  nowIso: string;
}) {
  return transitionInternalCheckin({ ...input, toStatus: "CANCELADO" });
}

export async function correctInternalCheckin(input: {
  actor: InternalCheckinActor;
  checkinId: string;
  patch: CheckinCorrectionPatch;
  expectedVersion: number;
  reason: string;
  nowIso: string;
}, officialRecordConfirmation?: OfficialRecordConfirmation) {
  const actor = requireManager(input.actor);
  const checkinId = requireDocumentId(input.checkinId, "Identificador do check-in");
  const expectedVersion = requireVersion(input.expectedVersion);
  const reason = requireReason(input.reason);
  const nowIso = requireIsoDate(input.nowIso);
  const checkinRef = adminDb.collection(CHECKINS_COLLECTION).doc(checkinId);

  const updated = await adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(checkinRef);
    const stored = asStoredCheckin(snapshot);
    assertExpectedVersion(stored, expectedVersion);
    assertNoUnsettledOfficialSync(stored);
    if (stored.status !== "PRE_CADASTRO") {
      requireOfficialConfirmation(officialRecordConfirmation);
    }

    const form = validateDriverCheckinInput({
      ...formFromStored(stored),
      ...input.patch
    });
    const changedFields = changedCorrectionFields(stored, form, input.patch);
    if (changedFields.length === 0) {
      throw new HttpError(400, "A correção não altera nenhum campo.");
    }
    const indexes = correctionIndexes(stored, form);
    const cnhChanged = indexes.driverLicenseIndex !== stored.driverLicenseIndex;
    const plateChanged = indexes.plateIndex !== stored.plateIndex;
    const active = isActiveVisit(stored.status);
    const nextCnhLock = cnhChanged && active
      ? uniquenessLockRef("cnh", indexes.driverLicenseIndex)
      : null;
    const nextPlateLock = plateChanged && active
      ? uniquenessLockRef("plate", indexes.plateIndex)
      : null;
    const [nextCnhSnapshot, nextPlateSnapshot] = await Promise.all([
      nextCnhLock ? transaction.get(nextCnhLock) : Promise.resolve(null),
      nextPlateLock ? transaction.get(nextPlateLock) : Promise.resolve(null)
    ]);
    if (
      (nextCnhSnapshot?.exists && nextCnhSnapshot.data()?.checkinId !== stored.id) ||
      (nextPlateSnapshot?.exists && nextPlateSnapshot.data()?.checkinId !== stored.id)
    ) {
      throw new HttpError(409, "Já existe uma visita ativa para os dados corrigidos.");
    }

    const nextVersion = stored.version + 1;
    const next: InternalStoredCheckin = {
      ...stored,
      ...form,
      ...indexes,
      syncState: stored.status === "PRE_CADASTRO" ? stored.syncState : "CONFIRMADO",
      version: nextVersion,
      updatedAtIso: nowIso
    };
    transaction.update(checkinRef, {
      ...form,
      ...indexes,
      syncState: next.syncState,
      version: nextVersion,
      updatedAtIso: nowIso
    });
    if (active && cnhChanged && nextCnhLock) {
      transaction.delete(uniquenessLockRef("cnh", stored.driverLicenseIndex));
      transaction.set(nextCnhLock, { kind: "CNH", checkinId: stored.id, updatedAtIso: nowIso });
    }
    if (active && plateChanged && nextPlateLock) {
      transaction.delete(uniquenessLockRef("plate", stored.plateIndex));
      transaction.set(nextPlateLock, { kind: "PLATE", checkinId: stored.id, updatedAtIso: nowIso });
    }
    transaction.create(
      checkinRef.collection("revisions").doc(),
      revisionPayload({
        action: "CHECKIN_CORRECTED",
        actor,
        reason,
        changedFields,
        previousVersion: stored.version,
        newVersion: nextVersion,
        createdAtIso: nowIso
      })
    );
    return next;
  });

  return managerDto(updated);
}

export async function overrideInternalCheckinLocation(input: {
  actor: InternalCheckinActor;
  checkinId: string;
  expectedVersion: number;
  justification: string;
  nowIso: string;
}, officialRecordConfirmation?: OfficialRecordConfirmation) {
  const actor = requireManager(input.actor);
  const checkinId = requireDocumentId(input.checkinId, "Identificador do check-in");
  const expectedVersion = requireVersion(input.expectedVersion);
  const justification = requireReason(input.justification, "Justificativa");
  const nowIso = requireIsoDate(input.nowIso);
  // The proof is injected by trusted server orchestration after Power Automate
  // confirms the official Excel row; it must never come from the request body.
  const confirmedAtIso = requireOfficialConfirmation(officialRecordConfirmation);
  const checkinRef = adminDb.collection(CHECKINS_COLLECTION).doc(checkinId);

  const updated = await adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(checkinRef);
    const stored = asStoredCheckin(snapshot);
    assertExpectedVersion(stored, expectedVersion);
    assertNoUnsettledOfficialSync(stored);
    if (
      !canTransitionCheckinStatus({
        role: actor.role,
        from: stored.status,
        to: "AGUARDANDO_LIBERACAO",
        trigger: "GPS_OVERRIDE"
      })
    ) {
      throw new HttpError(409, "Exceção de localização não permitida neste estado.");
    }

    const nextVersion = stored.version + 1;
    const locationOverride: LocationOverride = {
      applied: true,
      justification,
      approvedByUid: actor.uid,
      approvedByRole: actor.role,
      approvedAtIso: nowIso
    };
    const next: InternalStoredCheckin = {
      ...stored,
      status: "AGUARDANDO_LIBERACAO",
      syncState: "CONFIRMADO",
      locationOverride,
      confirmedAtIso,
      version: nextVersion,
      updatedAtIso: confirmedAtIso
    };
    transaction.update(checkinRef, {
      status: next.status,
      syncState: next.syncState,
      locationOverride,
      confirmedAtIso,
      version: nextVersion,
      updatedAtIso: confirmedAtIso
    });
    transaction.create(
      checkinRef.collection("revisions").doc(),
      revisionPayload({
        action: "GPS_OVERRIDE_CONFIRMED",
        actor,
        reason: justification,
        changedFields: ["status", "locationOverride"],
        previousVersion: stored.version,
        newVersion: nextVersion,
        createdAtIso: nowIso,
        fromStatus: stored.status,
        toStatus: "AGUARDANDO_LIBERACAO",
        highlight: "GPS_BYPASS"
      })
    );
    return next;
  });

  return managerDto(updated);
}
