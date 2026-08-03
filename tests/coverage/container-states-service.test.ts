import { Timestamp } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { inMemoryAdminDb } from "./in-memory-firestore";

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: inMemoryAdminDb
}));

import {
  availableStatusesFor,
  containerDocumentKey,
  eventContainerStatus,
  getContainerHistory,
  getCurrentContainerState,
  latestEventState,
  listContainerStates,
  lookupContainer,
  rebuildContainerState,
  reconcileContainerTimelineInTransaction
} from "@/lib/server/container-states";
import { EventDoc } from "@/types/domain";

const CONTAINER = "ABCU 123456-0";

function event(
  overrides: Partial<EventDoc> = {}
): EventDoc {
  return {
    pump: "BOMBA_1",
    shiftDate: "2026-07-27",
    shiftType: "MANHA",
    startTime: "06:00",
    endTime: "06:20",
    category: "PRODUTIVO",
    clientId: "client-1",
    plate: "ABC-1234",
    container: CONTAINER,
    containerStatus: "PARTIAL",
    containerReason: "Aguardando complemento",
    startsNewContainerCycle: false,
    blendConfirmed: false,
    notes: null,
    productive: true,
    origin: "MANUAL",
    generatedForEventId: null,
    gapSegmentId: null,
    justificationWaived: false,
    clientNameSnapshot: "Cliente 1",
    containerCycleId: "cycle-1",
    previousContainerEventId: null,
    containerStateVersion: 1,
    startAt: Timestamp.fromMillis(1_000),
    endAt: Timestamp.fromMillis(2_000),
    durationMinutes: 20,
    createdByUid: "operator",
    createdByEmail: "operator@example.com",
    updatedByUid: "operator",
    updatedByEmail: "operator@example.com",
    createdAt: Timestamp.fromMillis(1_100),
    updatedAt: Timestamp.fromMillis(1_100),
    deleted: false,
    deletedAt: null,
    deletedByUid: null,
    deletedByEmail: null,
    deletedReason: null,
    ...overrides
  };
}

describe("public container state service", () => {
  beforeEach(() => {
    inMemoryAdminDb.reset();
  });

  it("derives legacy and explicit statuses and normalizes document keys", () => {
    expect(containerDocumentKey("abcu 123456-0")).toBe("ABCU1234560");
    expect(eventContainerStatus({ containerStatus: "BUFFER" })).toBe("BUFFER");
    expect(
      eventContainerStatus({ category: "PRODUTIVO", container: CONTAINER })
    ).toBe("FULL");
    expect(eventContainerStatus({ category: "OUTROS" })).toBeNull();
  });

  it("falls back to the latest valid event when no materialized state exists", async () => {
    inMemoryAdminDb.seed("events", "invalid", {
      ...event({
        containerStatus: null,
        category: "OUTROS",
        endAt: Timestamp.fromMillis(4_000),
        createdAt: Timestamp.fromMillis(4_100)
      })
    });
    inMemoryAdminDb.seed("events", "latest-valid", {
      ...event({
        endAt: Timestamp.fromMillis(3_000),
        createdAt: Timestamp.fromMillis(3_100)
      })
    });

    const latest = await latestEventState(CONTAINER);
    expect(latest).toMatchObject({
      latestEventId: "latest-valid",
      container: CONTAINER,
      status: "PARTIAL",
      version: 0
    });
    expect(await getCurrentContainerState("abcu1234560")).toMatchObject({
      latestEventId: "latest-valid"
    });
  });

  it("returns a materialized lookup and the valid next statuses", async () => {
    inMemoryAdminDb.seed("containerStates", "ABCU1234560", {
      container: CONTAINER,
      status: "FULL",
      reason: null,
      cycleId: "cycle-1",
      latestEventId: "full",
      previousEventId: "partial",
      clientId: "client-1",
      clientNameSnapshot: "Cliente",
      plate: "ABC-1234",
      pump: "BOMBA_1",
      operationalAt: Timestamp.fromMillis(2_000),
      eventCreatedAt: Timestamp.fromMillis(2_100),
      version: 2,
      updatedAt: Timestamp.fromMillis(2_100)
    });

    const result = await lookupContainer("ABCU1234560");
    expect(result).toMatchObject({
      container: CONTAINER,
      requiresNewCycleConfirmation: true,
      availableStatuses: ["FULL", "PARTIAL", "BUFFER"]
    });
    expect(availableStatusesFor(null)).toEqual(["FULL", "PARTIAL", "BUFFER"]);
    expect(
      availableStatusesFor({
        ...result.current!,
        status: "BLEND_PARTIAL"
      })
    ).toEqual(["BLEND_FULL", "BLEND_PARTIAL"]);
    expect(
      availableStatusesFor({
        ...result.current!,
        status: "PARTIAL"
      })
    ).toEqual([
      "FULL",
      "PARTIAL",
      "BUFFER",
      "BLEND_FULL",
      "BLEND_PARTIAL"
    ]);
  });

  it("rejects invalid container identifiers at read boundaries", async () => {
    await expect(getCurrentContainerState("invalid")).rejects.toThrow(
      "Container inválido"
    );
    await expect(lookupContainer("invalid")).rejects.toThrow(
      "Container inválido"
    );
    await expect(getContainerHistory("invalid")).rejects.toThrow(
      "Container inválido"
    );
  });

  it("rebuilds a retroactive timeline and updates downstream links atomically", async () => {
    inMemoryAdminDb.seed(
      "containerStates",
      "ABCU1234560",
      {
        container: CONTAINER,
        version: 4
      }
    );
    inMemoryAdminDb.seed(
      "events",
      "first",
      event({
        endAt: Timestamp.fromMillis(1_000),
        createdAt: Timestamp.fromMillis(1_100),
        containerCycleId: "cycle-1"
      }) as unknown as Record<string, unknown>
    );
    inMemoryAdminDb.seed(
      "events",
      "last",
      event({
        endAt: Timestamp.fromMillis(3_000),
        createdAt: Timestamp.fromMillis(3_100),
        containerStatus: "FULL",
        containerReason: null,
        containerCycleId: "cycle-1",
        previousContainerEventId: "first"
      }) as unknown as Record<string, unknown>
    );

    const retroactive = event({
      endAt: Timestamp.fromMillis(2_000),
      createdAt: Timestamp.fromMillis(2_100),
      containerCycleId: null
    });
    const plan = await inMemoryAdminDb.runTransaction((transaction) =>
      reconcileContainerTimelineInTransaction({
        transaction: transaction as never,
        rawContainer: CONTAINER,
        override: { id: "retroactive", data: retroactive },
        expectedVersion: 4
      })
    );

    expect(plan).toMatchObject({
      cycleId: "cycle-1",
      previousEventId: "first",
      stateVersion: 5
    });
    expect(inMemoryAdminDb.read("events", "last")).toMatchObject({
      previousContainerEventId: "retroactive"
    });
    expect(inMemoryAdminDb.read("containerStates", "ABCU1234560")).toMatchObject({
      latestEventId: "last",
      previousEventId: "retroactive",
      status: "FULL",
      version: 5
    });
  });

  it("rolls back the transaction when a stale expected version is observed", async () => {
    inMemoryAdminDb.seed("containerStates", "ABCU1234560", {
      container: CONTAINER,
      version: 2,
      sentinel: "unchanged"
    });

    await expect(
      inMemoryAdminDb.runTransaction((transaction) =>
        reconcileContainerTimelineInTransaction({
          transaction: transaction as never,
          rawContainer: CONTAINER,
          override: { id: "new", data: event() },
          expectedVersion: 1
        })
      )
    ).rejects.toMatchObject({ status: 409 });
    expect(inMemoryAdminDb.read("containerStates", "ABCU1234560")).toEqual({
      container: CONTAINER,
      version: 2,
      sentinel: "unchanged"
    });
  });

  it("removes an empty projection and supports the rebuild convenience API", async () => {
    inMemoryAdminDb.seed("containerStates", "ABCU1234560", {
      container: CONTAINER,
      version: 1
    });
    await rebuildContainerState(CONTAINER);
    expect(inMemoryAdminDb.read("containerStates", "ABCU1234560")).toBeUndefined();
    await expect(rebuildContainerState(null)).resolves.toBeUndefined();
  });

  it("filters summaries and omits non-container history entries", async () => {
    inMemoryAdminDb.seed("containerStates", "ABCU1234560", {
      container: CONTAINER,
      status: "PARTIAL",
      operationalAt: Timestamp.fromMillis(3_000)
    });
    inMemoryAdminDb.seed("containerStates", "ZZZU9999999", {
      container: "ZZZU 999999-9",
      status: "FULL",
      operationalAt: Timestamp.fromMillis(2_000)
    });
    inMemoryAdminDb.seed("events", "container-event", event());
    inMemoryAdminDb.seed(
      "events",
      "manual-gap",
      event({
        category: "OUTROS",
        productive: false,
        containerStatus: null
      }) as unknown as Record<string, unknown>
    );

    expect(
      await listContainerStates({
        query: "123456",
        openOnly: false,
        pagination: { limit: 20 }
      })
    ).toMatchObject({ items: [expect.objectContaining({ container: CONTAINER })] });
    expect(
      await listContainerStates({
        openOnly: true,
        pagination: { limit: 20 }
      })
    ).toMatchObject({ items: [expect.objectContaining({ status: "PARTIAL" })] });
    expect(
      await listContainerStates({
        openOnly: false,
        status: "FULL",
        pagination: { limit: 20 }
      })
    ).toMatchObject({ items: [expect.objectContaining({ status: "FULL" })] });

    const history = await getContainerHistory(CONTAINER);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      id: "container-event",
      status: "PARTIAL"
    });
  });
});
