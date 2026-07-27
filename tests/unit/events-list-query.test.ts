import { beforeEach, describe, expect, it, vi } from "vitest";

const firestore = vi.hoisted(() => {
  const timestamp = (value: number) => ({ toMillis: () => value });
  const query = {
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    get: vi.fn()
  };

  query.where.mockReturnValue(query);
  query.orderBy.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  query.get.mockResolvedValue({
    docs: [
      {
        id: "event-1",
        data: () => ({
          shiftDate: "2026-07-27",
          pump: "BOMBA_2",
          shiftType: "MANHA",
          category: "PRODUTIVO",
          clientId: "client-1",
          containerStatus: "FULL",
          createdByUid: "admin-1",
          deleted: false,
          startAt: timestamp(200),
          endAt: timestamp(300),
          createdAt: timestamp(400)
        })
      }
    ]
  });

  return {
    collection: vi.fn(() => query),
    query
  };
});

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: firestore.collection
  }
}));

describe("listEvents Firestore query", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps combined filters out of the Firestore query", async () => {
    const { listEvents } = await import("@/lib/server/events");

    const result = await listEvents({
      role: "ADMIN",
      uid: "admin-1",
      filters: {
        dateFrom: "2026-07-27",
        dateTo: "2026-07-27",
        pump: "BOMBA_2",
        shiftType: "MANHA",
        category: "PRODUTIVO",
        clientId: "client-1",
        containerStatus: "FULL",
        includeDeleted: false
      }
    });

    expect(firestore.query.where.mock.calls).toEqual([
      ["shiftDate", ">=", "2026-07-27"],
      ["shiftDate", "<=", "2026-07-27"]
    ]);
    expect(firestore.query.orderBy).toHaveBeenCalledWith("shiftDate", "desc");
    expect(result.map((event) => event.id)).toEqual(["event-1"]);
  });
});
