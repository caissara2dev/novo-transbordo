import { describe, expect, it } from "vitest";
import {
  completeCheckinIntegrationRequest,
  failCheckinIntegrationRequest,
  reserveCheckinIntegrationRequest,
  type CheckinReplayStore
} from "@/lib/server/checkins/replay-protection";

type StoredDocument = Record<string, unknown>;

function createInMemoryStore(): {
  db: CheckinReplayStore;
  documents: Map<string, StoredDocument>;
} {
  const documents = new Map<string, StoredDocument>();
  const doc = (id: string) => ({ id });

  const db: CheckinReplayStore = {
    collection(name) {
      expect(name).toBe("_checkinIntegrationRequests");
      return { doc };
    },
    async runTransaction(callback) {
      return callback({
        async get(reference) {
          const data = documents.get(reference.id);
          return {
            exists: Boolean(data),
            data: () => (data ? { ...data } : undefined)
          };
        },
        set(reference, data) {
          documents.set(reference.id, { ...data });
        }
      });
    }
  };

  return { db, documents };
}

const requestId = "550e8400-e29b-41d4-a716-446655440000";
const bodyHash = "a".repeat(64);
const operation = "pre-registration.create";

describe("durable check-in request replay protection", () => {
  it("reserves a new request using only non-sensitive metadata", async () => {
    const { db, documents } = createInMemoryStore();

    await expect(
      reserveCheckinIntegrationRequest(
        { requestId, bodyHash, operation, nowIso: "2026-08-10T12:00:00.000Z" },
        db
      )
    ).resolves.toEqual({ kind: "reserved", attempt: 1 });

    expect(documents.get(requestId)).toEqual({
      requestId,
      bodyHash,
      operation,
      state: "PROCESSING",
      attempt: 1,
      createdAt: "2026-08-10T12:00:00.000Z",
      updatedAt: "2026-08-10T12:00:00.000Z",
      processingStartedAt: "2026-08-10T12:00:00.000Z"
    });
  });

  it("returns the stored safe response when the exact request is complete", async () => {
    const { db } = createInMemoryStore();
    await reserveCheckinIntegrationRequest(
      { requestId, bodyHash, operation, nowIso: "2026-08-10T12:00:00.000Z" },
      db
    );
    await completeCheckinIntegrationRequest(
      {
        requestId,
        bodyHash,
        operation,
        httpStatus: 201,
        envelope: {
          success: true,
          publicCode: "LT-ABCDEFGH",
          publicStatus: "processing",
          recovered: false,
          version: 1,
          examined: 10,
          expired: 4,
          hasMore: true
        },
        nowIso: "2026-08-10T12:00:01.000Z"
      },
      db
    );

    await expect(
      reserveCheckinIntegrationRequest(
        { requestId, bodyHash, operation, nowIso: "2026-08-10T12:00:02.000Z" },
        db
      )
    ).resolves.toEqual({
      kind: "completed",
      httpStatus: 201,
      envelope: {
        success: true,
        publicCode: "LT-ABCDEFGH",
        publicStatus: "processing",
        recovered: false,
        version: 1,
        examined: 10,
        expired: 4,
        hasMore: true
      }
    });
  });

  it("uses the same generic conflict for changed bodies and in-flight retries", async () => {
    const { db } = createInMemoryStore();
    await reserveCheckinIntegrationRequest(
      { requestId, bodyHash, operation, nowIso: "2026-08-10T12:00:00.000Z" },
      db
    );

    const processing = reserveCheckinIntegrationRequest(
      { requestId, bodyHash, operation, nowIso: "2026-08-10T12:00:01.000Z" },
      db
    );
    const changedBody = reserveCheckinIntegrationRequest(
      {
        requestId,
        bodyHash: "b".repeat(64),
        operation,
        nowIso: "2026-08-10T12:00:01.000Z"
      },
      db
    );

    await expect(processing).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    await expect(changedBody).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    await expect(processing).rejects.toThrow("Requisição já utilizada.");
    await expect(changedBody).rejects.toThrow("Requisição já utilizada.");
  });

  it("allows an explicit retry after failure without losing the original identity", async () => {
    const { db, documents } = createInMemoryStore();
    await reserveCheckinIntegrationRequest(
      { requestId, bodyHash, operation, nowIso: "2026-08-10T12:00:00.000Z" },
      db
    );
    await failCheckinIntegrationRequest(
      {
        requestId,
        bodyHash,
        operation,
        errorCode: "EXCEL_TIMEOUT",
        nowIso: "2026-08-10T12:00:10.000Z"
      },
      db
    );

    await expect(
      reserveCheckinIntegrationRequest(
        { requestId, bodyHash, operation, nowIso: "2026-08-10T12:00:20.000Z" },
        db
      )
    ).resolves.toEqual({ kind: "reserved", attempt: 2 });

    expect(documents.get(requestId)).toMatchObject({
      requestId,
      bodyHash,
      operation,
      state: "PROCESSING",
      attempt: 2,
      createdAt: "2026-08-10T12:00:00.000Z",
      updatedAt: "2026-08-10T12:00:20.000Z",
      processingStartedAt: "2026-08-10T12:00:20.000Z"
    });
    expect(documents.get(requestId)).not.toHaveProperty("errorCode");
  });

  it("rejects unsafe response fields instead of persisting PII", async () => {
    const { db, documents } = createInMemoryStore();
    await reserveCheckinIntegrationRequest(
      { requestId, bodyHash, operation, nowIso: "2026-08-10T12:00:00.000Z" },
      db
    );

    await expect(
      completeCheckinIntegrationRequest(
        {
          requestId,
          bodyHash,
          operation,
          httpStatus: 200,
          envelope: { success: true, phone: "13999999999" } as never,
          nowIso: "2026-08-10T12:00:01.000Z"
        },
        db
      )
    ).rejects.toThrow(/envelope seguro/i);
    expect(documents.get(requestId)).toMatchObject({ state: "PROCESSING" });
  });

  it("validates request identifiers, body hashes and state ownership", async () => {
    const { db } = createInMemoryStore();

    await expect(
      reserveCheckinIntegrationRequest(
        { requestId: "invalid", bodyHash, operation, nowIso: "2026-08-10T12:00:00.000Z" },
        db
      )
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      completeCheckinIntegrationRequest(
        {
          requestId,
          bodyHash,
          operation,
          httpStatus: 200,
          envelope: { success: true },
          nowIso: "2026-08-10T12:00:00.000Z"
        },
        db
      )
    ).rejects.toMatchObject({ status: 409 });
  });
});
