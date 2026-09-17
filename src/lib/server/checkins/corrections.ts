import "server-only";
import { createHmac } from "node:crypto";
import { adminDb } from "@/lib/firebase/admin";
import { checkinStatuses, validateDriverCheckinInput } from "@/lib/domain/checkins";
import type { CheckinStatus, DriverCheckinForm } from "@/lib/domain/checkins";
import { HttpError } from "@/lib/domain/errors";
import type { UserRole, UserDoc } from "@/types/domain";
import type { StoredCheckin } from "@/types/checkins";
const CHECKINS_COLLECTION = "checkins";
const UNIQUE_LOCKS_COLLECTION = "_checkinUniqueLocks";
const MAX_REASON_LENGTH = 500;
type InternalCheckinActor = { uid: string; role: UserRole };
type InternalStoredCheckin = StoredCheckin;
type CheckinCorrectionPatch = Partial<DriverCheckinForm>;
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
  if (!["OPERATOR", "SUPERVISOR", "ADMIN", "ANALYST"].includes(actor.role)) {
    throw new HttpError(403, "Este perfil não pode acessar check-ins.");
  }
  return { uid: actor.uid.trim(), role: actor.role };
}

function requireManager(
  actor: InternalCheckinActor
): InternalCheckinActor & { role: "SUPERVISOR" | "ADMIN" | "ANALYST" } {
  const valid = requireActor(actor);
  if (valid.role !== "SUPERVISOR" && valid.role !== "ADMIN" && valid.role !== "ANALYST") {
    throw new HttpError(403, "Apenas Analista, Supervisor ou Admin pode executar esta ação.");
  }
  return valid as InternalCheckinActor & { role: "SUPERVISOR" | "ADMIN" | "ANALYST" };
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

export async function correctInternalCheckin(input: {
  actor: InternalCheckinActor;
  checkinId: string;
  patch: CheckinCorrectionPatch;
  expectedVersion: number;
  reason: string;
  nowIso: string;
}) {
  const actor = requireManager(input.actor);
  const checkinId = requireDocumentId(input.checkinId, "Identificador do check-in");
  const expectedVersion = requireVersion(input.expectedVersion);
  const reason = requireReason(input.reason);
  const nowIso = requireIsoDate(input.nowIso);
  const checkinRef = adminDb.collection(CHECKINS_COLLECTION).doc(checkinId);

  await adminDb.runTransaction(async (transaction) => {
    const user = await transaction.get(adminDb.collection("users").doc(actor.uid));
    const profile = user.data() as UserDoc | undefined;
    if (!profile?.active || !profile.approved || profile.role !== actor.role) throw new HttpError(403, "As permissões foram alteradas. Atualize a sessão.");
    const snapshot = await transaction.get(checkinRef);
    const stored = asStoredCheckin(snapshot);
    assertExpectedVersion(stored, expectedVersion);
    assertNoUnsettledOfficialSync(stored);

    if (stored.activeProductiveEventId && (input.patch.plate !== undefined || input.patch.driverLicense !== undefined)) {
      if ((input.patch.plate && input.patch.plate !== stored.plate) || (input.patch.driverLicense && input.patch.driverLicense !== stored.driverLicense)) throw new HttpError(409, "A identidade de uma visita vinculada deve ser corrigida junto ao lançamento.");
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
      updatedAtIso: nowIso,
      updatedBy: profile.name || profile.email || "Equipe Line"
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


}
