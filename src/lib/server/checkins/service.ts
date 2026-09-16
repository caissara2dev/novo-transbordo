import "server-only";

import {
  createHmac,
  randomInt,
  randomUUID
} from "node:crypto";
import { adminDb } from "@/lib/firebase/admin";
import {
  canTransitionCheckinStatus,
  evaluateCheckinGeofence,
  isPreRegistrationExpired,
  validateDriverCheckinInput
} from "@/lib/domain/checkins";
import type { CheckinGeofenceResult } from "@/lib/domain/checkins";
import { HttpError } from "@/lib/domain/errors";
import { normalizePlate } from "@/lib/domain/identifiers";
import type {
  CheckinSource,
  CheckinAllowedArea,
  CheckinGeofenceInput,
  PreRegistrationResult,
  PublicCheckinState,
  StoredCheckin
} from "@/types/checkins";

import { prepareVisitDocument } from "./documents";
import type { DocumentReceipt } from "@/lib/domain/checkin-document";

const CHECKINS_COLLECTION = "checkins";
const UNIQUE_LOCKS_COLLECTION = "_checkinUniqueLocks";
const PUBLIC_CODES_COLLECTION = "_checkinPublicCodes";
const PUBLIC_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const MAX_PUBLIC_CODE_ATTEMPTS = 5;

class PublicCodeCollisionError extends Error {}

type BaseDependencies = {
  hmacSecret?: string;
  generateId?: () => string;
  generatePublicCode?: () => string;
};

type CreatePreRegistrationInput = {
  rawForm: unknown;
  source: CheckinSource;
  nowIso: string;
  requestId?: string;
};

type RecoverPreRegistrationInput = {
  driverLicense: string;
  driverPhone: string;
  plate: string;
  nowIso: string;
};

type ConfirmCheckinInput = {
  document?: DocumentReceipt;
  documentOperation?: "confirm" | "walk-in";
  publicCode: string;
  driverLicense: string;
  driverPhone: string;
  plate: string;
  location: CheckinGeofenceInput;
  nowIso: string;
  expectedVersion: number;
  requestId?: string;
};

type ConfirmCheckinDependencies = Pick<BaseDependencies, "hmacSecret"> & {
  allowedArea: CheckinAllowedArea;
};

type IdentityIndexes = Pick<
  StoredCheckin,
  "driverLicenseIndex" | "driverPhoneIndex" | "plateIndex"
>;

function requireIsoDate(value: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new HttpError(400, "Horário da operação inválido.");
  }
  return value;
}

function requireSource(value: CheckinSource): CheckinSource {
  if (value !== "DRIVER" && value !== "CARRIER") {
    throw new HttpError(400, "Origem do pré-cadastro inválida.");
  }
  return value;
}

function requireUuid(value: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    )
  ) {
    throw new HttpError(500, "Gerador de identificador interno inválido.");
  }
  return value;
}

function requireFreshLocationCapture(capturedAtIso: string, nowIso: string): string {
  const capturedAt = Date.parse(capturedAtIso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(capturedAt)) {
    throw new HttpError(400, "Horário da localização inválido.");
  }
  const ageMs = now - capturedAt;
  if (ageMs > 2 * 60 * 1_000 || ageMs < -30 * 1_000) {
    throw new HttpError(422, "Não foi possível validar a localização atual.");
  }
  return capturedAtIso;
}

function requireHmacSecret(override?: string): string {
  const secret = override ?? process.env.CHECKIN_INDEX_HMAC_SECRET ?? "";
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

function buildIdentityIndexes(
  secret: string,
  identity: { driverLicense: string; driverPhone: string; plate: string }
): IdentityIndexes {
  return {
    driverLicenseIndex: identityIndex(secret, "cnh", identity.driverLicense),
    driverPhoneIndex: identityIndex(secret, "phone", identity.driverPhone),
    plateIndex: identityIndex(secret, "plate", identity.plate)
  };
}

function digitsOnly(value: unknown): string {
  return typeof value === "string" ? value.replace(/\D/g, "") : "";
}

function hasValidCnhVerifiers(value: string): boolean {
  if (!/^\d{11}$/.test(value) || /^(\d)\1{10}$/.test(value)) return false;
  const digits = [...value].map(Number);
  const firstSum = digits
    .slice(0, 9)
    .reduce((sum, digit, index) => sum + digit * (9 - index), 0);
  const secondSum = digits
    .slice(0, 9)
    .reduce((sum, digit, index) => sum + digit * (index + 1), 0);
  const firstVerifier = firstSum % 11 === 10 ? 0 : firstSum % 11;
  const secondVerifier = secondSum % 11 === 10 ? 0 : secondSum % 11;
  return digits[9] === firstVerifier && digits[10] === secondVerifier;
}

export function normalizeIdentityInput(input: {
  driverLicense: string;
  driverPhone: string;
  plate: string;
}) {
  const driverLicense = digitsOnly(input.driverLicense);
  const driverPhone = digitsOnly(input.driverPhone);
  const plate = normalizePlate(input.plate);
  if (!hasValidCnhVerifiers(driverLicense)) {
    throw new HttpError(400, "CNH inválida.");
  }
  if (!/^\d{2}9\d{8}$/.test(driverPhone)) {
    throw new HttpError(400, "Telefone inválido.");
  }
  if (!plate) {
    throw new HttpError(400, "Placa inválida.");
  }
  return { driverLicense, driverPhone, plate };
}

function defaultPublicCode(): string {
  let suffix = "";
  for (let index = 0; index < 8; index += 1) {
    suffix += PUBLIC_CODE_ALPHABET[randomInt(PUBLIC_CODE_ALPHABET.length)];
  }
  return `LT-${suffix}`;
}

function assertPublicCode(value: string): string {
  if (!/^LT-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/.test(value)) {
    throw new HttpError(500, "Gerador de código público inválido.");
  }
  return value;
}

function normalizePublicCode(value: string): string {
  return assertPublicCode(value.trim().toUpperCase());
}

function lockRef(kind: "cnh" | "plate", index: string) {
  return adminDb
    .collection(UNIQUE_LOCKS_COLLECTION)
    .doc(`${kind}_${index.replace(":", "_")}`);
}

function publicState(
  stored: StoredCheckin,
  recovered = false
): PreRegistrationResult {
  return {
    publicCode: stored.publicCode,
    status: stored.status,
    syncState: stored.syncState,
    version: stored.version,
    recovered
  };
}

function publicCheckinState(stored: StoredCheckin): PublicCheckinState {
  const { recovered: _recovered, ...state } = publicState(stored);
  void _recovered;
  return state;
}

function sanitizedGeofence(
  geofence: CheckinGeofenceResult
): CheckinGeofenceResult {
  return {
    ...geofence,
    distanceMeters: Math.round(geofence.distanceMeters / 100) * 100
  };
}

function assertIdentityMatches(
  stored: StoredCheckin,
  indexes: IdentityIndexes
): void {
  if (
    stored.driverLicenseIndex !== indexes.driverLicenseIndex ||
    stored.driverPhoneIndex !== indexes.driverPhoneIndex ||
    stored.plateIndex !== indexes.plateIndex
  ) {
    throw new HttpError(404, "Não foi possível localizar um pré-cadastro ativo.");
  }
}

function expirePreRegistration(params: {
  transaction: FirebaseFirestore.Transaction;
  stored: StoredCheckin;
  nowIso: string;
}): boolean {
  // An Excel-backed manager command owns this visit until it commits or is retried.
  if (
    params.stored.pendingOfficialMutation ||
    (params.stored.status === "PRE_CADASTRO" && params.stored.syncState !== null)
  ) {
    return false;
  }
  if (
    !isPreRegistrationExpired({
      status: params.stored.status,
      createdAtIso: params.stored.createdAtIso,
      nowIso: params.nowIso
    })
  ) {
    return false;
  }

  const checkinRef = adminDb
    .collection(CHECKINS_COLLECTION)
    .doc(params.stored.id);
  const nextVersion = params.stored.version + 1;
  params.transaction.update(checkinRef, {
    status: "CANCELADO",
    cancellationReason: "EXPIRADO",
    syncState: null,
    version: nextVersion,
    updatedAtIso: params.nowIso
  });
  params.transaction.delete(
    lockRef("cnh", params.stored.driverLicenseIndex)
  );
  params.transaction.delete(lockRef("plate", params.stored.plateIndex));
  params.transaction.create(checkinRef.collection("revisions").doc(), {
    action: "PRE_REGISTRATION_EXPIRED",
    source: "SYSTEM",
    requestId: null,
    previousVersion: params.stored.version,
    newVersion: nextVersion,
    reason: "EXPIRADO",
    createdAtIso: params.nowIso
  });
  return true;
}

async function findRecoverableCheckin(params: {
  transaction: FirebaseFirestore.Transaction;
  cnhLock: FirebaseFirestore.DocumentSnapshot;
  plateLock: FirebaseFirestore.DocumentSnapshot;
  indexes: IdentityIndexes;
  nowIso: string;
}): Promise<StoredCheckin | null> {
  if (!params.cnhLock.exists && !params.plateLock.exists) return null;
  const cnhOwner = params.cnhLock.exists
    ? String(params.cnhLock.data()?.checkinId ?? "")
    : null;
  const plateOwner = params.plateLock.exists
    ? String(params.plateLock.data()?.checkinId ?? "")
    : null;
  if (!cnhOwner || cnhOwner !== plateOwner) {
    throw new HttpError(409, "Já existe uma visita ativa para os dados informados.");
  }

  const snapshot = await params.transaction.get(
    adminDb.collection(CHECKINS_COLLECTION).doc(cnhOwner)
  );
  const existing = snapshot.data() as StoredCheckin | undefined;
  if (
    !snapshot.exists ||
    !existing ||
    existing.driverPhoneIndex !== params.indexes.driverPhoneIndex ||
    existing.status === "CANCELADO" ||
    existing.status === "CONCLUIDO"
  ) {
    throw new HttpError(409, "Já existe uma visita ativa para os dados informados.");
  }
  return expirePreRegistration({
    transaction: params.transaction,
    stored: existing,
    nowIso: params.nowIso
  })
    ? null
    : existing;
}

function persistPreRegistration(params: {
  transaction: FirebaseFirestore.Transaction;
  stored: StoredCheckin;
  requestId?: string;
}): void {
  const { transaction, stored } = params;
  const checkinRef = adminDb.collection(CHECKINS_COLLECTION).doc(stored.id);
  transaction.create(
    adminDb.collection(PUBLIC_CODES_COLLECTION).doc(stored.publicCode),
    { checkinId: stored.id, createdAtIso: stored.createdAtIso }
  );
  for (const [kind, index] of [
    ["cnh", stored.driverLicenseIndex],
    ["plate", stored.plateIndex]
  ] as const) {
    transaction.create(lockRef(kind, index), {
      kind: kind === "cnh" ? "CNH" : "PLATE",
      checkinId: stored.id,
      createdAtIso: stored.createdAtIso
    });
  }
  transaction.create(checkinRef, stored);
  transaction.create(checkinRef.collection("revisions").doc(), {
    action: "PRE_REGISTRATION_CREATED",
    source: stored.source,
    requestId: params.requestId ?? null,
    previousVersion: 0,
    newVersion: 1,
    createdAtIso: stored.createdAtIso
  });
}

async function attemptPreRegistration(params: {
  stored: StoredCheckin;
  indexes: IdentityIndexes;
  nowIso: string;
  requestId?: string;
}): Promise<StoredCheckin | null> {
  return adminDb.runTransaction(async (transaction) => {
    const [codeClaim, cnhLock, plateLock] = await Promise.all([
      transaction.get(
        adminDb.collection(PUBLIC_CODES_COLLECTION).doc(params.stored.publicCode)
      ),
      transaction.get(lockRef("cnh", params.indexes.driverLicenseIndex)),
      transaction.get(lockRef("plate", params.indexes.plateIndex))
    ]);
    // HMAC-derived lock documents make the CNH-or-plate uniqueness check atomic.
    const recovered = await findRecoverableCheckin({
      transaction,
      cnhLock,
      plateLock,
      indexes: params.indexes,
      nowIso: params.nowIso
    });
    if (recovered) return recovered;
    if (codeClaim.exists) throw new PublicCodeCollisionError();
    persistPreRegistration({
      transaction,
      stored: params.stored,
      requestId: params.requestId
    });
    return null;
  });
}

export async function createOrRecoverPreRegistration(
  input: CreatePreRegistrationInput,
  dependencies: BaseDependencies = {}
): Promise<PreRegistrationResult> {
  const form = validateDriverCheckinInput(input.rawForm);
  const source = requireSource(input.source);
  const nowIso = requireIsoDate(input.nowIso);
  const secret = requireHmacSecret(dependencies.hmacSecret);
  const id = requireUuid((dependencies.generateId ?? randomUUID)());
  const indexes = buildIdentityIndexes(secret, form);
  const generatePublicCode = dependencies.generatePublicCode ?? defaultPublicCode;

  for (let attempt = 0; attempt < MAX_PUBLIC_CODE_ATTEMPTS; attempt += 1) {
    const publicCode = assertPublicCode(generatePublicCode());
    const stored: StoredCheckin = {
      id,
      publicCode,
      source,
      status: "PRE_CADASTRO",
      syncState: null,
      ...form,
      ...indexes,
      geofence: null,
      cancellationReason: null,
      version: 1,
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
      confirmedAtIso: null
    };
    try {
      const recovered = await attemptPreRegistration({
        stored,
        indexes,
        nowIso,
        requestId: input.requestId
      });
      return recovered ? publicState(recovered, true) : publicState(stored);
    } catch (error) {
      if (!(error instanceof PublicCodeCollisionError)) throw error;
    }
  }

  throw new HttpError(500, "Não foi possível gerar um código público único.");
}

export async function recoverPreRegistrationCode(
  input: RecoverPreRegistrationInput,
  dependencies: Pick<BaseDependencies, "hmacSecret"> = {}
): Promise<PublicCheckinState> {
  requireIsoDate(input.nowIso);
  const identity = normalizeIdentityInput(input);
  const secret = requireHmacSecret(dependencies.hmacSecret);
  const indexes = {
    driverLicenseIndex: identityIndex(secret, "cnh", identity.driverLicense),
    driverPhoneIndex: identityIndex(secret, "phone", identity.driverPhone),
    plateIndex: identityIndex(secret, "plate", identity.plate)
  };

  const stored = await adminDb.runTransaction(async (transaction) => {
    const [cnhLock, plateLock] = await Promise.all([
      transaction.get(lockRef("cnh", indexes.driverLicenseIndex)),
      transaction.get(lockRef("plate", indexes.plateIndex))
    ]);
    const cnhOwner = cnhLock.exists
      ? String(cnhLock.data()?.checkinId ?? "")
      : null;
    const plateOwner = plateLock.exists
      ? String(plateLock.data()?.checkinId ?? "")
      : null;
    if (!cnhOwner || cnhOwner !== plateOwner) return null;

    const snapshot = await transaction.get(
      adminDb.collection(CHECKINS_COLLECTION).doc(cnhOwner)
    );
    const candidate = snapshot.data() as StoredCheckin | undefined;
    if (
      !snapshot.exists ||
      !candidate ||
      candidate.driverPhoneIndex !== indexes.driverPhoneIndex ||
      candidate.status === "CANCELADO" ||
      candidate.status === "CONCLUIDO"
    ) {
      return null;
    }
    if (expirePreRegistration({
      transaction,
      stored: candidate,
      nowIso: input.nowIso
    })) {
      return null;
    }
    return candidate;
  });

  if (!stored) {
    // The same response covers every partial mismatch to avoid identity enumeration.
    throw new HttpError(404, "Não foi possível localizar um pré-cadastro ativo.");
  }
  return publicCheckinState(stored);
}

type ConfirmationContext = {
  nowIso: string;
  publicCode: string;
  indexes: IdentityIndexes;
  geofence: CheckinGeofenceResult;
};

function validateConfirmation(
  input: ConfirmCheckinInput,
  dependencies: ConfirmCheckinDependencies
): ConfirmationContext {
  const nowIso = requireIsoDate(input.nowIso);
  const capturedAtIso = requireFreshLocationCapture(
    input.location.capturedAtIso,
    nowIso
  );
  const identity = normalizeIdentityInput(input);
  const indexes = buildIdentityIndexes(
    requireHmacSecret(dependencies.hmacSecret),
    identity
  );
  const geofence = evaluateCheckinGeofence({
    allowedArea: dependencies.allowedArea,
    driverLocation: {
      latitude: input.location.latitude,
      longitude: input.location.longitude,
      accuracyMeters: input.location.accuracyMeters
    },
    validatedAtIso: capturedAtIso
  });
  if (!geofence.allowed) {
    const message =
      geofence.reason === "GPS_ACCURACY_TOO_LOW"
        ? "A precisão do GPS não é suficiente para confirmar o check-in."
        : "O motorista está fora da região permitida para o check-in.";
    throw new HttpError(422, message);
  }
  return {
    nowIso,
    publicCode: normalizePublicCode(input.publicCode),
    indexes,
    geofence: sanitizedGeofence(geofence)
  };
}

/** The official record and arrival transition commit together; no external side effect. */
export async function confirmCheckin(input: ConfirmCheckinInput, dependencies: ConfirmCheckinDependencies): Promise<PublicCheckinState> {
  const context = validateConfirmation(input, dependencies);
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new HttpError(400, "Versão inválida.");
  const result = await adminDb.runTransaction(async transaction => {
    const claim = await transaction.get(adminDb.collection(PUBLIC_CODES_COLLECTION).doc(context.publicCode));
    if (!claim.exists) return null;
    const ref = adminDb.collection(CHECKINS_COLLECTION).doc(String(claim.data()?.checkinId));
    const snap = await transaction.get(ref);
    const stored = snap.data() as StoredCheckin | undefined;
    if (!snap.exists || !stored) return null;
    assertIdentityMatches(stored, context.indexes);
    if (stored.status !== "PRE_CADASTRO" && stored.status !== "CANCELADO" && stored.confirmedAtIso) {
      if(input.document && stored.document && input.document.sessionId!==stored.document.sessionId)
        throw new HttpError(409,"Esta visita já tem check-in confirmado. Para complementar a nota, fale com a Line.");
      return publicCheckinState(stored);
    }
    if (stored.pendingOfficialMutation) throw new HttpError(409, "Visita legada pendente de reconciliação.");
    if (expirePreRegistration({ transaction, stored, nowIso: context.nowIso })) return null;
    if (stored.version !== input.expectedVersion || !canTransitionCheckinStatus({ role: "SYSTEM", from: stored.status, to: "AGUARDANDO_LIBERACAO", trigger: "CHECKIN_CONFIRMED" })) throw new HttpError(409, "O pré-cadastro foi alterado. Atualize e tente novamente.");
    const invoice = process.env.CHECKIN_DOCUMENTS_ENABLED === "true"
      ? await prepareVisitDocument(transaction,input.document,input,stored.id,stored.publicCode,input.documentOperation??"confirm") : undefined;
    const patch = {
      ...(invoice ? {document:invoice.document,environment:"homologation" as const} : {}),
      status: "AGUARDANDO_LIBERACAO" as const, syncState: "CONFIRMADO" as const,
      version: stored.version + 1, confirmedAtIso: context.nowIso, updatedAtIso: context.nowIso,
      recordVersion: 2, geofence: context.geofence,
      location: { latitude: input.location.latitude, longitude: input.location.longitude,
        accuracyMeters: input.location.accuracyMeters, capturedAtIso: input.location.capturedAtIso },
      booking: "", sample: "", observation: "", issues: [], updatedBy: "Sistema"
    };
    invoice?.link();
    transaction.update(ref, patch);
    transaction.create(ref.collection("revisions").doc(), {
      action: "CHECKIN_CONFIRMED", source: "SYSTEM", actor: "Sistema", requestId: input.requestId ?? null,
      previousVersion: stored.version, newVersion: patch.version,
      changedFields: ["status", "confirmedAtIso", "location"], createdAtIso: context.nowIso
    });
    return publicCheckinState({ ...stored, ...patch });
  });
  if (!result) throw new HttpError(404, "Não foi possível localizar um pré-cadastro ativo.");
  return result;
}
