import { beforeEach, describe, expect, it, vi } from "vitest";

type FakeDoc = {
  id: string;
  data: () => Record<string, unknown>;
};

const firestore = vi.hoisted(() => {
  const timestamp = (value: number) => ({ toMillis: () => value });
  const pageQueue: FakeDoc[][] = [];
  const docsById = new Map<string, FakeDoc>();
  const query = {
    where: vi.fn(),
    orderBy: vi.fn(),
    startAfter: vi.fn(),
    limit: vi.fn(),
    get: vi.fn(),
    doc: vi.fn()
  };

  for (const method of [
    query.where,
    query.orderBy,
    query.startAfter,
    query.limit
  ]) {
    method.mockReturnValue(query);
  }
  query.get.mockImplementation(async () => ({
    docs: pageQueue.shift() || []
  }));
  query.doc.mockImplementation((id: string) => ({
    get: vi.fn(async () => {
      const doc = docsById.get(id);
      return {
        exists: Boolean(doc),
        id,
        data: () => doc?.data()
      };
    })
  }));

  return {
    collection: vi.fn(() => query),
    docsById,
    pageQueue,
    query,
    timestamp
  };
});

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: firestore.collection
  }
}));

function eventDoc(params: {
  id: string;
  createdByUid?: string;
  shiftDate?: string;
  pump?: string;
  startAt?: number;
  deleted?: boolean;
  containerCycleId?: string;
  previousContainerEventId?: string | null;
  plate?: string | null;
  status?: string | null;
  startTime?: string;
  endTime?: string;
}): FakeDoc {
  const startAt = params.startAt ?? 200;
  return {
    id: params.id,
    data: () => ({
      shiftDate: params.shiftDate ?? "2026-07-27",
      pump: params.pump ?? "BOMBA_2",
      shiftType: "MANHA",
      category: "PRODUTIVO",
      clientId: "client-1",
      container: "ABCU 123456-0",
      containerStatus: params.status ?? "FULL",
      createdByUid: params.createdByUid ?? "operator-1",
      deleted: params.deleted ?? false,
      startTime: params.startTime ?? "06:00",
      endTime: params.endTime ?? "06:10",
      plate: params.plate ?? "AAA-1A23",
      containerCycleId: params.containerCycleId ?? null,
      previousContainerEventId: params.previousContainerEventId ?? null,
      startAt: firestore.timestamp(startAt),
      endAt: firestore.timestamp(startAt + 50),
      createdAt: firestore.timestamp(startAt + 100)
    })
  };
}

describe("listEvents pagination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    firestore.docsById.clear();
    firestore.pageQueue.length = 0;
    firestore.query.get.mockImplementation(async () => ({
      docs: firestore.pageQueue.shift() || []
    }));
  });

  it("applies authorization, deletion and date bounds before limiting", async () => {
    firestore.pageQueue.push([
      eventDoc({ id: "event-1", createdByUid: "operator-1" })
    ]);
    const { listEvents } = await import("@/lib/server/events");

    const result = await listEvents({
      role: "OPERATOR",
      uid: "operator-1",
      filters: {
        dateFrom: "2026-07-27",
        dateTo: "2026-07-27",
        includeDeleted: false
      },
      pagination: { limit: 50 }
    });

    expect(firestore.query.where.mock.calls).toEqual(
      expect.arrayContaining([
        ["createdByUid", "==", "operator-1"],
        ["deleted", "==", false],
        ["shiftDate", ">=", "2026-07-27"],
        ["shiftDate", "<=", "2026-07-27"]
      ])
    );
    expect(firestore.query.limit).toHaveBeenCalled();
    expect(result.items.map((event) => event.id)).toEqual(["event-1"]);
    expect(result.nextCursor).toBeNull();
    expect(result.incomplete).toBe(false);
  });

  it("scans additional Firestore pages until secondary filters fill the page", async () => {
    firestore.pageQueue.push(
      Array.from({ length: 50 }, (_, index) =>
        eventDoc({
          id: `wrong-${index}`,
          pump: "BOMBA_1",
          startAt: 500 - index
        })
      ),
      [
        eventDoc({ id: "matching-3", startAt: 300 }),
        eventDoc({ id: "matching-2", startAt: 200 }),
        eventDoc({ id: "matching-1", startAt: 100 })
      ]
    );
    const { listEvents } = await import("@/lib/server/events");

    const result = await listEvents({
      role: "ADMIN",
      uid: "admin-1",
      filters: { pump: "BOMBA_2", includeDeleted: false },
      pagination: { limit: 2 }
    });

    expect(firestore.query.get).toHaveBeenCalledTimes(2);
    expect(firestore.query.startAfter).toHaveBeenCalled();
    expect(result.items.map((event) => event.id)).toEqual([
      "matching-3",
      "matching-2"
    ]);
    expect(result.nextCursor).toEqual(expect.any(String));
    expect(result.incomplete).toBe(false);
  });

  it("never exposes another operator's event after a cursor", async () => {
    firestore.pageQueue.push([
      eventDoc({ id: "other-user", createdByUid: "operator-2", startAt: 150 }),
      eventDoc({ id: "own-event", createdByUid: "operator-1", startAt: 100 })
    ]);
    const { listEvents } = await import("@/lib/server/events");

    const first = await listEvents({
      role: "OPERATOR",
      uid: "operator-1",
      filters: { includeDeleted: false },
      pagination: { limit: 1 }
    });

    expect(first.items.map((event) => event.id)).toEqual(["own-event"]);
    expect(
      firestore.query.where.mock.calls.filter(
        (call) => call[0] === "createdByUid"
      )
    ).toEqual([["createdByUid", "==", "operator-1"]]);
  });

  it("resumes after the last returned document with a stable document-id tie breaker", async () => {
    firestore.pageQueue.push([
      eventDoc({ id: "event-b", startAt: 200 }),
      eventDoc({ id: "event-a", startAt: 200 })
    ]);
    const { listEvents } = await import("@/lib/server/events");

    const first = await listEvents({
      role: "ADMIN",
      uid: "admin-1",
      filters: {},
      pagination: { limit: 1 }
    });
    firestore.pageQueue.push([eventDoc({ id: "event-a", startAt: 200 })]);

    const second = await listEvents({
      role: "ADMIN",
      uid: "admin-1",
      filters: {},
      pagination: {
        limit: 1,
        cursor: first.nextCursor || undefined
      }
    });

    expect(first.items.map((event) => event.id)).toEqual(["event-b"]);
    expect(firestore.query.startAfter.mock.calls.at(-1)?.[1]).toBe("event-b");
    expect(second.items.map((event) => event.id)).toEqual(["event-a"]);
  });

  it("returns a continuation instead of scanning without a bound", async () => {
    for (let page = 0; page < 10; page += 1) {
      firestore.pageQueue.push(
        Array.from({ length: 200 }, (_, index) =>
          eventDoc({
            id: `wrong-${page}-${index}`,
            pump: "BOMBA_1",
            startAt: 5000 - page * 200 - index
          })
        )
      );
    }
    const { listEvents } = await import("@/lib/server/events");

    const result = await listEvents({
      role: "ADMIN",
      uid: "admin-1",
      filters: { pump: "BOMBA_2" },
      pagination: { limit: 200 }
    });

    expect(firestore.query.get).toHaveBeenCalledTimes(10);
    expect(result.items).toEqual([]);
    expect(result.incomplete).toBe(true);
    expect(result.nextCursor).toEqual(expect.any(String));
  });

  it("loads previous container passages by cycle outside the active filters", async () => {
    firestore.docsById.set(
      "previous-1",
      eventDoc({
        id: "previous-1",
        shiftDate: "2026-07-26",
        pump: "BOMBA_1",
        containerCycleId: "cycle-1",
        status: "PARTIAL",
        plate: "ABC-1234",
        startTime: "07:00",
        endTime: "07:15"
      })
    );
    firestore.pageQueue.push([
      eventDoc({
        id: "current",
        pump: "BOMBA_2",
        containerCycleId: "cycle-1",
        previousContainerEventId: "previous-1",
        status: "FULL",
        startAt: 500
      })
    ]);
    firestore.pageQueue.push(
      [...firestore.docsById.values(), ...firestore.pageQueue[0]],
      []
    );
    const { listEvents } = await import("@/lib/server/events");

    const result = await listEvents({
      role: "ADMIN",
      uid: "admin-1",
      filters: {},
      pagination: { limit: 50 }
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].previousContainerPassages).toEqual([
      {
        id: "previous-1",
        startTime: "07:00",
        endTime: "07:15",
        pump: "BOMBA_1",
        plate: "ABC-1234",
        status: "PARTIAL",
        role: "DESTINATION",
        relatedContainer: null
      }
    ]);
  });

  it("does not expose previous passages from another operator", async () => {
    firestore.docsById.set(
      "other-operator-event",
      eventDoc({
        id: "other-operator-event",
        createdByUid: "operator-2",
        containerCycleId: "cycle-1",
        status: "PARTIAL"
      })
    );
    firestore.pageQueue.push([
      eventDoc({
        id: "current",
        createdByUid: "operator-1",
        containerCycleId: "cycle-1",
        previousContainerEventId: "other-operator-event",
        startAt: 500,
        status: "FULL"
      })
    ]);
    firestore.pageQueue.push(
      [...firestore.docsById.values(), ...firestore.pageQueue[0]],
      []
    );
    const { listEvents } = await import("@/lib/server/events");

    const result = await listEvents({
      role: "OPERATOR",
      uid: "operator-1",
      filters: {},
      pagination: { limit: 50 }
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].previousContainerPassages).toEqual([]);
  });

  it("rejects a malformed opaque cursor", async () => {
    const { listEvents } = await import("@/lib/server/events");

    await expect(
      listEvents({
        role: "ADMIN",
        uid: "admin-1",
        filters: {},
        pagination: { limit: 50, cursor: "not-a-valid-cursor" }
      })
    ).rejects.toMatchObject({ status: 400 });
  });
});
