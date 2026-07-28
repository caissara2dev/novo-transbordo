import { beforeEach, describe, expect, it, vi } from "vitest";

type FakeDoc = {
  id: string;
  data: () => Record<string, unknown>;
};

const firestore = vi.hoisted(() => {
  const timestamp = (value: number) => ({ toMillis: () => value });
  const pageQueue: FakeDoc[][] = [];
  const query = {
    where: vi.fn(),
    orderBy: vi.fn(),
    startAfter: vi.fn(),
    limit: vi.fn(),
    get: vi.fn()
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

  return {
    collection: vi.fn(() => query),
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

function stateDoc(id: string, container: string, operationalAt: number): FakeDoc {
  return {
    id,
    data: () => ({
      container,
      status: "PARTIAL",
      operationalAt: firestore.timestamp(operationalAt),
      eventCreatedAt: firestore.timestamp(operationalAt),
      updatedAt: firestore.timestamp(operationalAt)
    })
  };
}

describe("listContainerStates pagination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    firestore.pageQueue.length = 0;
    firestore.query.get.mockImplementation(async () => ({
      docs: firestore.pageQueue.shift() || []
    }));
  });

  it("scans beyond the first batch when searching for a container", async () => {
    firestore.pageQueue.push(
      Array.from({ length: 50 }, (_, index) =>
        stateDoc(`ZZZZ${index}`, `ZZZZ ${index}`, 500 - index)
      ),
      [
        stateDoc("ABCU1234560", "ABCU 123456-0", 300),
        stateDoc("ABCU7654321", "ABCU 765432-1", 200)
      ]
    );
    const { listContainerStates } = await import(
      "@/lib/server/container-states"
    );

    const result = await listContainerStates({
      query: "ABCU",
      openOnly: true,
      pagination: { limit: 1 }
    });

    expect(firestore.query.where).toHaveBeenCalledWith(
      "status",
      "in",
      expect.any(Array)
    );
    expect(firestore.query.get).toHaveBeenCalledTimes(2);
    expect(result.items.map((item) => item.container)).toEqual([
      "ABCU 123456-0"
    ]);
    expect(result.nextCursor).toEqual(expect.any(String));
  });

  it("rejects a cursor created for another query scope", async () => {
    firestore.pageQueue.push([
      stateDoc("ABCU1234560", "ABCU 123456-0", 300),
      stateDoc("ABCU7654321", "ABCU 765432-1", 200)
    ]);
    const { listContainerStates } = await import(
      "@/lib/server/container-states"
    );

    const first = await listContainerStates({
      query: "ABCU",
      openOnly: true,
      pagination: { limit: 1 }
    });

    await expect(
      listContainerStates({
        query: "ZZZZ",
        openOnly: true,
        pagination: {
          limit: 1,
          cursor: first.nextCursor || undefined
        }
      })
    ).rejects.toMatchObject({ status: 400 });
  });
});
