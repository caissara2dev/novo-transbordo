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
  CheckinExcelAdapter,
  ExcelCheckinRecord,
  CheckinGeofenceInput,
  PreRegistrationResult,
  PublicCheckinState,
  StoredCheckin
} from "@/types/checkins";

const CHECKINS_COLLECTION = "checkins";
const UNIQUE_LOCKS_COLLECTION = "_checkinUniqueLocks";
const PUBLIC_CODES_COLLECTION = "_checkinPublicCodes";
const SYNC_COMMANDS_COLLECTION = "_checkinSyncCommands";
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
  excelAdapter: CheckinExcelAdapter;
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

function normalizeIdentityInput(input: {
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

type ConfirmationPreparation =
  | { kind: "NOT_FOUND" }
  | { kind: "EXPIRED" }
  | { kind: "CONFIRMED"; stored: StoredCheckin }
  | { kind: "READY"; checkinId: string; stored: StoredCheckin };

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

async function beginSyncAttempt(params: {
  transaction: FirebaseFirestore.Transaction;
  checkinRef: FirebaseFirestore.DocumentReference;
  stored: StoredCheckin;
  context: ConfirmationContext;
  requestId?: string;
}): Promise<StoredCheckin> {
  const syncRef = adminDb.collection(SYNC_COMMANDS_COLLECTION).doc(params.stored.id);
  const syncSnapshot = await params.transaction.get(syncRef);
  const next: StoredCheckin = {
    ...params.stored,
    syncState: "EM_PROCESSAMENTO",
    geofence: params.context.geofence,
    updatedAtIso: params.context.nowIso
  };
  params.transaction.set(syncRef, {
    checkinId: params.stored.id,
    publicCode: params.context.publicCode,
    operation: "INCLUDE",
    state: "EM_PROCESSAMENTO",
    attempts: Number(syncSnapshot.data()?.attempts ?? 0) + 1,
    requestId: params.requestId ?? null,
    startedAtIso: params.context.nowIso,
    updatedAtIso: params.context.nowIso,
    lastErrorCode: null
  }, { merge: true });
  params.transaction.update(params.checkinRef, {
    syncState: next.syncState,
    geofence: next.geofence,
    updatedAtIso: next.updatedAtIso
  });
  params.transaction.create(params.checkinRef.collection("revisions").doc(), {
    action: "CHECKIN_SYNC_STARTED",
    source: "SYSTEM",
    requestId: params.requestId ?? null,
    previousVersion: params.stored.version,
    newVersion: params.stored.version,
    changedFields: ["syncState", "geofence"],
    createdAtIso: params.context.nowIso
  });
  return next;
}

async function prepareConfirmation(params: {
  input: ConfirmCheckinInput;
  context: ConfirmationContext;
}): Promise<ConfirmationPreparation> {
  return adminDb.runTransaction(async (transaction) => {
    const codeClaim = await transaction.get(
      adminDb.collection(PUBLIC_CODES_COLLECTION).doc(params.context.publicCode)
    );
    if (!codeClaim.exists) return { kind: "NOT_FOUND" as const };
    const checkinId = String(codeClaim.data()?.checkinId ?? "");
    const checkinRef = adminDb.collection(CHECKINS_COLLECTION).doc(checkinId);
    const snapshot = await transaction.get(checkinRef);
    const stored = snapshot.data() as StoredCheckin | undefined;
    if (!snapshot.exists || !stored) return { kind: "NOT_FOUND" as const };
    assertIdentityMatches(stored, params.context.indexes);
    if (stored.status === "AGUARDANDO_LIBERACAO" && stored.syncState === "CONFIRMADO") {
      return { kind: "CONFIRMED" as const, stored };
    }
    if (
      stored.pendingOfficialMutation ||
      (stored.syncState !== null && stored.syncState !== "FALHA_RETRY")
    ) {
      throw new HttpError(
        409,
        "Há uma confirmação oficial em processamento. Aguarde e tente novamente."
      );
    }
    if (expirePreRegistration({ transaction, stored, nowIso: params.context.nowIso })) {
      return { kind: "EXPIRED" as const };
    }
    if (stored.status !== "PRE_CADASTRO" || stored.version !== params.input.expectedVersion) {
      throw new HttpError(409, "O pré-cadastro foi alterado. Atualize os dados e tente novamente.");
    }
    const syncing = await beginSyncAttempt({
      transaction,
      checkinRef,
      stored,
      context: params.context,
      requestId: params.input.requestId
    });
    return { kind: "READY" as const, checkinId, stored: syncing };
  });
}

function excelRecord(stored: StoredCheckin, startedAtIso: string): ExcelCheckinRecord {
  return {
    publicCode: stored.publicCode,
    form: {
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
    },
    startedAtIso
  };
}

function persistConfirmation(params: {
  transaction: FirebaseFirestore.Transaction;
  checkinRef: FirebaseFirestore.DocumentReference;
  syncRef: FirebaseFirestore.DocumentReference;
  latest: StoredCheckin;
  confirmedAtIso: string;
  requestId?: string;
}): StoredCheckin {
  const next: StoredCheckin = {
    ...params.latest,
    status: "AGUARDANDO_LIBERACAO",
    syncState: "CONFIRMADO",
    version: params.latest.version + 1,
    updatedAtIso: params.confirmedAtIso,
    confirmedAtIso: params.confirmedAtIso
  };
  params.transaction.update(params.checkinRef, {
    status: next.status,
    syncState: next.syncState,
    version: next.version,
    updatedAtIso: next.updatedAtIso,
    confirmedAtIso: next.confirmedAtIso
  });
  params.transaction.set(params.syncRef, {
    state: "CONFIRMADO",
    confirmedAtIso: params.confirmedAtIso,
    updatedAtIso: params.confirmedAtIso,
    lastErrorCode: null
  }, { merge: true });
  params.transaction.create(params.checkinRef.collection("revisions").doc(), {
    action: "CHECKIN_CONFIRMED",
    source: "SYSTEM",
    requestId: params.requestId ?? null,
    previousVersion: params.latest.version,
    newVersion: next.version,
    changedFields: ["status", "syncState", "confirmedAtIso"],
    createdAtIso: params.confirmedAtIso
  });
  return next;
}

async function commitConfirmation(params: {
  input: ConfirmCheckinInput;
  context: ConfirmationContext;
  preparation: Extract<ConfirmationPreparation, { kind: "READY" }>;
  confirmedAtIso: string;
}): Promise<StoredCheckin> {
  const checkinRef = adminDb.collection(CHECKINS_COLLECTION).doc(params.preparation.checkinId);
  const syncRef = adminDb.collection(SYNC_COMMANDS_COLLECTION).doc(params.preparation.checkinId);
  return adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(checkinRef);
    const latest = snapshot.data() as StoredCheckin | undefined;
    if (!snapshot.exists || !latest) throw new HttpError(404, "Pré-cadastro não encontrado.");
    assertIdentityMatches(latest, params.context.indexes);
    if (latest.status === "AGUARDANDO_LIBERACAO" && latest.syncState === "CONFIRMADO") {
      return latest;
    }
    if (
      latest.pendingOfficialMutation ||
      latest.status !== "PRE_CADASTRO" ||
      latest.version !== params.input.expectedVersion ||
      !canTransitionCheckinStatus({
        role: "SYSTEM",
        from: latest.status,
        to: "AGUARDANDO_LIBERACAO",
        trigger: "CHECKIN_CONFIRMED"
      })
    ) {
      throw new HttpError(409, "O pré-cadastro foi alterado durante a confirmação.");
    }
    return persistConfirmation({
      transaction,
      checkinRef,
      syncRef,
      latest,
      confirmedAtIso: params.confirmedAtIso,
      requestId: params.input.requestId
    });
  });
}

async function markSyncFailure(params: {
  preparation: Extract<ConfirmationPreparation, { kind: "READY" }>;
  nowIso: string;
  requestId?: string;
}): Promise<void> {
  const checkinRef = adminDb.collection(CHECKINS_COLLECTION).doc(params.preparation.checkinId);
  const syncRef = adminDb.collection(SYNC_COMMANDS_COLLECTION).doc(params.preparation.checkinId);
  await adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(checkinRef);
    const latest = snapshot.data() as StoredCheckin | undefined;
    if (
      !snapshot.exists ||
      !latest ||
      latest.status !== "PRE_CADASTRO" ||
      latest.pendingOfficialMutation
    ) {
      return;
    }
    transaction.update(checkinRef, { syncState: "FALHA_RETRY", updatedAtIso: params.nowIso });
    transaction.set(syncRef, {
      state: "FALHA_RETRY",
      updatedAtIso: params.nowIso,
      lastErrorCode: "EXCEL_TEMPORARILY_UNAVAILABLE"
    }, { merge: true });
    transaction.create(checkinRef.collection("revisions").doc(), {
      action: "CHECKIN_SYNC_FAILED",
      source: "SYSTEM",
      requestId: params.requestId ?? null,
      previousVersion: latest.version,
      newVersion: latest.version,
      changedFields: ["syncState"],
      reason: "EXCEL_TEMPORARILY_UNAVAILABLE",
      createdAtIso: params.nowIso
    });
  });
}

export async function confirmCheckin(
  input: ConfirmCheckinInput,
  dependencies: ConfirmCheckinDependencies
): Promise<PublicCheckinState> {
  const context = validateConfirmation(input, dependencies);
  const preparation = await prepareConfirmation({ input, context });
  if (preparation.kind === "NOT_FOUND" || preparation.kind === "EXPIRED") {
    throw new HttpError(404, "Não foi possível localizar um pré-cadastro ativo.");
  }
  if (preparation.kind === "CONFIRMED") return publicCheckinState(preparation.stored);
  try {
    // The public code is the adapter's idempotency key; the network call stays outside Firestore.
    const excelConfirmation = await dependencies.excelAdapter.includeIdempotently(
      excelRecord(preparation.stored, context.nowIso)
    );
    const confirmedAtIso = excelConfirmation.confirmedAtIso;
    if (!Number.isFinite(Date.parse(confirmedAtIso))) throw new Error("Invalid Excel confirmation");
    const confirmed = await commitConfirmation({
      input,
      context,
      preparation,
      confirmedAtIso
    });
    return publicCheckinState(confirmed);
  } catch (error) {
    if (error instanceof HttpError && error.status >= 400 && error.status < 500) {
      throw error;
    }
    // A transient adapter failure never advances the optimistic visit version.
    await markSyncFailure({ preparation, nowIso: context.nowIso, requestId: input.requestId });
    throw new HttpError(503, "O registro oficial está temporariamente indisponível. Tente novamente.");
  }
}
