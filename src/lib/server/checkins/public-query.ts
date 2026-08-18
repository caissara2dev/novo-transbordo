import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { HttpError } from "@/lib/domain/errors";
import { normalizePlate } from "@/lib/domain/identifiers";
import { adminDb } from "@/lib/firebase/admin";
import type { StoredCheckin } from "@/types/checkins";

const PUBLIC_CODE_PATTERN = /^LT-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/;

export type PublicCheckinStatus = "processing" | "confirmed" | "cancelled";

export type CheckinPublicQueryStore = {
  findByPublicCode(publicCode: string): Promise<StoredCheckin | null>;
};

type PublicQueryDependencies = {
  hmacSecret?: string;
  store?: CheckinPublicQueryStore;
};

const firestoreStore: CheckinPublicQueryStore = {
  async findByPublicCode(publicCode) {
    const claim = await adminDb
      .collection("_checkinPublicCodes")
      .doc(publicCode)
      .get();
    const checkinId = claim.exists ? String(claim.data()?.checkinId ?? "") : "";
    if (!checkinId) return null;

    const snapshot = await adminDb.collection("checkins").doc(checkinId).get();
    return snapshot.exists ? (snapshot.data() as StoredCheckin) : null;
  }
};

function notFound(): HttpError {
  // Unknown codes and identity mismatches deliberately share one response.
  return new HttpError(404, "Não foi possível localizar o check-in.");
}

function requireSecret(override?: string): string {
  const secret = override ?? process.env.CHECKIN_INDEX_HMAC_SECRET ?? "";
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new HttpError(500, "Configuração de identidade do check-in inválida.");
  }
  return secret;
}

function normalizeCode(value: string): string {
  const code = value.trim().toUpperCase();
  if (!PUBLIC_CODE_PATTERN.test(code)) throw notFound();
  return code;
}

function normalizePhone(value: string): string {
  const phone = value.replace(/\D/g, "");
  if (!/^\d{2}9\d{8}$/.test(phone)) throw notFound();
  return phone;
}

function identityIndex(secret: string, namespace: string, value: string): string {
  return `v1:${createHmac("sha256", secret)
    .update(`${namespace}:${value}`)
    .digest("hex")}`;
}

function equalIndex(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function toPublicStatus(checkin: StoredCheckin): PublicCheckinStatus {
  if (checkin.status === "CANCELADO") return "cancelled";
  if (checkin.status === "PRE_CADASTRO") return "processing";
  return "confirmed";
}

export async function getPublicCheckinStatus(
  input: { publicCode: string; driverPhone: string },
  dependencies: PublicQueryDependencies = {}
): Promise<{ status: PublicCheckinStatus }> {
  const publicCode = normalizeCode(input.publicCode);
  const phone = normalizePhone(input.driverPhone);
  const expectedPhoneIndex = identityIndex(
    requireSecret(dependencies.hmacSecret),
    "phone",
    phone
  );
  const checkin = await (dependencies.store ?? firestoreStore).findByPublicCode(publicCode);

  if (!checkin || !equalIndex(checkin.driverPhoneIndex, expectedPhoneIndex)) {
    throw notFound();
  }
  return { status: toPublicStatus(checkin) };
}

export async function resolvePublicCheckinVersion(
  input: {
    publicCode: string;
    driverLicense: string;
    driverPhone: string;
    plate: string;
  },
  dependencies: PublicQueryDependencies = {}
): Promise<number> {
  const publicCode = normalizeCode(input.publicCode);
  const driverLicense = input.driverLicense.replace(/\D/g, "");
  const driverPhone = normalizePhone(input.driverPhone);
  const plate = normalizePlate(input.plate);
  if (!/^\d{11}$/.test(driverLicense) || !plate) throw notFound();

  const secret = requireSecret(dependencies.hmacSecret);
  const expected = [
    identityIndex(secret, "cnh", driverLicense),
    identityIndex(secret, "phone", driverPhone),
    identityIndex(secret, "plate", plate)
  ];
  const checkin = await (dependencies.store ?? firestoreStore).findByPublicCode(publicCode);
  const actual = checkin
    ? [checkin.driverLicenseIndex, checkin.driverPhoneIndex, checkin.plateIndex]
    : [];
  if (
    !checkin ||
    actual.length !== expected.length ||
    !actual.every((value, index) => equalIndex(value, expected[index])) ||
    !Number.isSafeInteger(checkin.version) ||
    checkin.version <= 0
  ) {
    throw notFound();
  }
  if (
    checkin.status === "PRE_CADASTRO" &&
    (checkin.pendingOfficialMutation ||
      (checkin.syncState !== null && checkin.syncState !== "FALHA_RETRY"))
  ) {
    throw new HttpError(
      409,
      "Há uma confirmação oficial em processamento. Aguarde e tente novamente."
    );
  }
  return checkin.version;
}
