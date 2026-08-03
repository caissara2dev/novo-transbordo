import { createHmac } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";

const BUCKET_COLLECTION = "_requestRateLimits";
const BUCKET_TTL_MS = 24 * 60 * 60 * 1_000;

export type RateLimitPolicy = {
  name: "AUTH" | "READ" | "WRITE" | "ADMIN";
  requestsPerMinute: number;
};

type StoredBucket = {
  tokens?: unknown;
  lastRefillAtMs?: unknown;
};

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function bucketDocumentId(
  secret: string,
  keyVersion: string,
  policy: RateLimitPolicy,
  identity: string
): string {
  return createHmac("sha256", secret)
    .update(`${keyVersion}:${policy.name}:${identity}`)
    .digest("hex");
}

export async function consumeRateLimit({
  identity,
  keyVersion,
  policy,
  secret,
  now = new Date()
}: {
  identity: string;
  keyVersion: string;
  policy: RateLimitPolicy;
  secret: string;
  now?: Date;
}): Promise<RateLimitResult> {
  const nowMs = now.getTime();
  const capacity = policy.requestsPerMinute;
  const refillPerMs = capacity / 60_000;
  const bucketRef = adminDb
    .collection(BUCKET_COLLECTION)
    .doc(bucketDocumentId(secret, keyVersion, policy, identity));

  return adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(bucketRef);
    const stored = (snapshot.exists ? snapshot.data() : undefined) as StoredBucket | undefined;
    const lastRefillAtMs = Math.min(
      nowMs,
      finiteNumber(stored?.lastRefillAtMs, nowMs)
    );
    const storedTokens = finiteNumber(stored?.tokens, capacity);
    const availableTokens = Math.min(
      capacity,
      Math.max(0, storedTokens) + (nowMs - lastRefillAtMs) * refillPerMs
    );
    const allowed = availableTokens >= 1;
    const nextTokens = allowed ? availableTokens - 1 : availableTokens;

    transaction.set(bucketRef, {
      keyVersion,
      policy: policy.name,
      tokens: nextTokens,
      lastRefillAtMs: nowMs,
      expiresAt: Timestamp.fromMillis(nowMs + BUCKET_TTL_MS)
    });

    if (allowed) {
      return { allowed: true };
    }

    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((1 - availableTokens) / refillPerMs / 1_000))
    };
  });
}
