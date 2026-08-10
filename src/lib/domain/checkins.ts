import { HttpError } from "@/lib/domain/errors";
import { normalizePlate } from "@/lib/domain/identifiers";

export const checkinStatuses = [
  "PRE_CADASTRO",
  "AGUARDANDO_LIBERACAO",
  "AGUARDANDO_CHAMADA",
  "CHAMADO",
  "EM_DESCARGA",
  "CONCLUIDO",
  "CANCELADO"
] as const;

export type CheckinStatus = (typeof checkinStatuses)[number];
export type CheckinActorRole =
  | "SYSTEM"
  | "OPERATOR"
  | "SUPERVISOR"
  | "ADMIN"
  | "DISPLAY";
export type CheckinTransitionTrigger =
  | "MANUAL"
  | "CHECKIN_CONFIRMED"
  | "PRODUCTIVE_EVENT"
  | "GPS_OVERRIDE"
  | "EXPIRATION";

export type DriverCheckinForm = {
  driverName: string;
  driverLicense: string;
  driverPhone: string;
  plate: string;
  carrierName: string;
  vehicleType: "Bitrem" | "Rodotrem" | "Vanderleia";
  product: string;
  originPlant: string;
  originInvoiceNumbers: string;
  remittanceInvoiceNumber: string;
  whatsappNoticeAccepted: true;
  queueLocationAccepted: true;
};

export type CheckinGeofenceResult = {
  allowed: boolean;
  reason?: "OUTSIDE_ALLOWED_RADIUS" | "GPS_ACCURACY_TOO_LOW";
  distanceMeters: number;
  radiusMeters: number;
  accuracyMeters: number;
  validatedAtIso: string;
};

const EARTH_RADIUS_METERS = 6_371_000;
const MAX_GPS_ACCURACY_METERS = 1_000;
const PRE_REGISTRATION_TTL_MS = 5 * 24 * 60 * 60 * 1_000;

function requireText(value: unknown, label: string, maxLength = 120): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, `${label} é obrigatório.`);
  }

  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new HttpError(400, `${label} excede o limite de ${maxLength} caracteres.`);
  }

  return normalized;
}

function digitsOnly(value: unknown): string {
  return typeof value === "string" ? value.replace(/\D/g, "") : "";
}

function isValidCnh(value: string): boolean {
  if (!/^\d{11}$/.test(value) || /^(\d)\1{10}$/.test(value)) {
    return false;
  }

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

function normalizePhone(value: unknown): string {
  const phone = digitsOnly(value);
  const ddd = Number(phone.slice(0, 2));

  if (
    phone.length !== 11 ||
    ddd < 11 ||
    ddd > 99 ||
    phone[2] !== "9" ||
    /^(\d)\1{10}$/.test(phone)
  ) {
    throw new HttpError(400, "Telefone inválido. Informe DDD e celular com 11 dígitos.");
  }

  return phone;
}

function assertCoordinate(value: number, min: number, max: number): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new HttpError(400, "Coordenada de GPS inválida.");
  }
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function distanceInMeters(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number }
): number {
  const deltaLatitude = toRadians(to.latitude - from.latitude);
  const deltaLongitude = toRadians(to.longitude - from.longitude);
  const fromLatitude = toRadians(from.latitude);
  const toLatitude = toRadians(to.latitude);
  const haversine =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(fromLatitude) *
      Math.cos(toLatitude) *
      Math.sin(deltaLongitude / 2) ** 2;

  const distance =
    2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));

  // Exact coordinates are deliberately discarded; 100 m precision is sufficient
  // to audit the geofence decision without retaining a driver's parking position.
  return Math.round(distance / 100) * 100;
}

export function evaluateCheckinGeofence(input: {
  allowedArea: { latitude: number; longitude: number; radiusMeters: number };
  driverLocation: {
    latitude: number;
    longitude: number;
    accuracyMeters: number;
  };
  validatedAtIso: string;
}): CheckinGeofenceResult {
  assertCoordinate(input.allowedArea.latitude, -90, 90);
  assertCoordinate(input.allowedArea.longitude, -180, 180);
  assertCoordinate(input.driverLocation.latitude, -90, 90);
  assertCoordinate(input.driverLocation.longitude, -180, 180);

  if (!Number.isFinite(input.allowedArea.radiusMeters) || input.allowedArea.radiusMeters <= 0) {
    throw new HttpError(500, "Raio de localização inválido.");
  }
  if (
    !Number.isFinite(input.driverLocation.accuracyMeters) ||
    input.driverLocation.accuracyMeters <= 0
  ) {
    throw new HttpError(400, "Precisão do GPS inválida.");
  }
  if (!Number.isFinite(Date.parse(input.validatedAtIso))) {
    throw new HttpError(400, "Horário de validação do GPS inválido.");
  }

  const distanceMeters = distanceInMeters(input.allowedArea, input.driverLocation);
  const common = {
    distanceMeters,
    radiusMeters: input.allowedArea.radiusMeters,
    accuracyMeters: input.driverLocation.accuracyMeters,
    validatedAtIso: input.validatedAtIso
  };

  if (input.driverLocation.accuracyMeters > MAX_GPS_ACCURACY_METERS) {
    return { ...common, allowed: false, reason: "GPS_ACCURACY_TOO_LOW" };
  }
  if (distanceMeters > input.allowedArea.radiusMeters) {
    return { ...common, allowed: false, reason: "OUTSIDE_ALLOWED_RADIUS" };
  }

  return { ...common, allowed: true };
}

export function validateDriverCheckinInput(raw: unknown): DriverCheckinForm {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpError(400, "Dados do motorista inválidos.");
  }

  const input = raw as Record<string, unknown>;
  const driverLicense = digitsOnly(input.driverLicense);
  if (!isValidCnh(driverLicense)) {
    throw new HttpError(400, "CNH inválida. Confira os 11 dígitos e o dígito verificador.");
  }

  const vehicleType = requireText(input.vehicleType, "Tipo de veículo");
  if (vehicleType !== "Bitrem" && vehicleType !== "Rodotrem" && vehicleType !== "Vanderleia") {
    throw new HttpError(400, "Tipo de veículo inválido.");
  }
  if (input.whatsappNoticeAccepted !== true) {
    throw new HttpError(400, "Confirme que está ciente do envio da NF por WhatsApp.");
  }
  if (input.queueLocationAccepted !== true) {
    throw new HttpError(400, "Confirme que está ciente das regras de localização e fila.");
  }

  return {
    driverName: requireText(input.driverName, "Nome do motorista"),
    driverLicense,
    driverPhone: normalizePhone(input.driverPhone),
    plate: normalizePlate(requireText(input.plate, "Placa")) as string,
    carrierName: requireText(input.carrierName, "Transportadora"),
    vehicleType,
    product: requireText(input.product, "Produto"),
    originPlant: requireText(input.originPlant, "Usina de origem"),
    originInvoiceNumbers: requireText(
      input.originInvoiceNumbers,
      "Nota fiscal de usina",
      250
    ),
    remittanceInvoiceNumber: requireText(
      input.remittanceInvoiceNumber,
      "Nota fiscal de remessa",
      250
    ),
    whatsappNoticeAccepted: true,
    queueLocationAccepted: true
  };
}

export function buildCheckinStoragePayload(input: {
  id: string;
  form: DriverCheckinForm;
  geofence: CheckinGeofenceResult;
  createdAtIso: string;
}) {
  return {
    id: input.id,
    status: "PRE_CADASTRO" as const,
    ...input.form,
    geofence: { ...input.geofence },
    createdAtIso: input.createdAtIso
  };
}

export function isPreRegistrationExpired(input: {
  status: CheckinStatus;
  createdAtIso: string;
  nowIso: string;
}): boolean {
  if (input.status !== "PRE_CADASTRO") return false;

  const createdAt = Date.parse(input.createdAtIso);
  const now = Date.parse(input.nowIso);
  if (!Number.isFinite(createdAt) || !Number.isFinite(now)) {
    throw new HttpError(400, "Data do pré-cadastro inválida.");
  }

  return now - createdAt >= PRE_REGISTRATION_TTL_MS;
}

export function canTransitionCheckinStatus(input: {
  role: CheckinActorRole;
  from: CheckinStatus;
  to: CheckinStatus;
  trigger: CheckinTransitionTrigger;
}): boolean {
  const { role, from, to, trigger } = input;

  if (role === "SYSTEM") {
    return (
      (from === "PRE_CADASTRO" &&
        to === "AGUARDANDO_LIBERACAO" &&
        trigger === "CHECKIN_CONFIRMED") ||
      (from === "PRE_CADASTRO" && to === "CANCELADO" && trigger === "EXPIRATION")
    );
  }

  if (
    (role === "OPERATOR" || role === "SUPERVISOR" || role === "ADMIN") &&
    from === "CHAMADO" &&
    to === "EM_DESCARGA" &&
    trigger === "PRODUCTIVE_EVENT"
  ) {
    return true;
  }

  if (role !== "SUPERVISOR" && role !== "ADMIN") return false;
  if (trigger === "GPS_OVERRIDE") {
    return from === "PRE_CADASTRO" && to === "AGUARDANDO_LIBERACAO";
  }
  if (trigger !== "MANUAL") return false;
  if (to === "CANCELADO" && from !== "CONCLUIDO" && from !== "CANCELADO") return true;

  return (
    (from === "AGUARDANDO_LIBERACAO" && to === "AGUARDANDO_CHAMADA") ||
    (from === "AGUARDANDO_CHAMADA" && to === "CHAMADO") ||
    (from === "EM_DESCARGA" && to === "CONCLUIDO") ||
    (from === "EM_DESCARGA" && to === "CHAMADO")
  );
}
