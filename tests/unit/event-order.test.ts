import { describe, expect, it } from "vitest";
import {
  filterAndSortOperationalHistory,
  sortByOperationalTimeline
} from "@/lib/domain/event-order";

describe("sortByOperationalTimeline", () => {
  it("places an automatic gap after the productive event that follows it", () => {
    const sharedCreatedAt = new Date("2026-07-27T17:30:00.000Z");
    const items = [
      {
        id: "automatic-gap",
        startAt: new Date("2026-07-27T09:00:00.000Z"),
        endAt: new Date("2026-07-27T17:00:00.000Z"),
        createdAt: sharedCreatedAt
      },
      {
        id: "productive-b2",
        startAt: new Date("2026-07-27T17:00:00.000Z"),
        endAt: new Date("2026-07-27T17:27:00.000Z"),
        createdAt: sharedCreatedAt
      },
      {
        id: "productive-b1",
        startAt: new Date("2026-07-27T17:16:00.000Z"),
        endAt: new Date("2026-07-27T17:22:00.000Z"),
        createdAt: new Date("2026-07-27T17:22:00.000Z")
      }
    ];

    expect(sortByOperationalTimeline(items).map((item) => item.id)).toEqual([
      "productive-b1",
      "productive-b2",
      "automatic-gap"
    ]);
  });

  it("uses end time, creation time and id as deterministic tie breakers", () => {
    const startAt = "2026-07-27T17:00:00.000Z";
    const createdAt = "2026-07-27T17:30:00.000Z";
    const items = [
      { id: "a", startAt, endAt: "2026-07-27T17:10:00.000Z", createdAt },
      { id: "b", startAt, endAt: "2026-07-27T17:20:00.000Z", createdAt },
      { id: "c", startAt, endAt: "2026-07-27T17:20:00.000Z", createdAt }
    ];

    expect(sortByOperationalTimeline(items).map((item) => item.id)).toEqual(["c", "b", "a"]);
  });

  it("normalizes Firestore-like, numeric and missing timeline values", () => {
    const items = [
      {
        id: "timestamp",
        startAt: { toMillis: () => 20 },
        endAt: null,
        createdAt: null
      },
      {
        id: "number",
        startAt: 10,
        endAt: undefined,
        createdAt: undefined
      }
    ];

    expect(sortByOperationalTimeline(items).map((item) => item.id)).toEqual([
      "timestamp",
      "number"
    ]);
  });

  it("applies combined history filters without relying on a composite query", () => {
    const base = {
      startAt: "2026-07-27T17:00:00.000Z",
      endAt: "2026-07-27T17:20:00.000Z",
      createdAt: "2026-07-27T17:21:00.000Z",
      shiftDate: "2026-07-27",
      pump: "BOMBA_2",
      shiftType: "MANHA",
      clientId: "client-1",
      containerStatus: null,
      createdByUid: "operator-1",
      deleted: false
    };
    const items = [
      { ...base, id: "matching", category: "PRODUTIVO" },
      { ...base, id: "wrong-category", category: "MANUTENCAO" },
      { ...base, id: "deleted", category: "PRODUTIVO", deleted: true },
      {
        ...base,
        id: "another-operator",
        category: "PRODUTIVO",
        createdByUid: "operator-2"
      }
    ];

    const result = filterAndSortOperationalHistory(items, {
      role: "OPERATOR",
      uid: "operator-1",
      filters: {
        dateFrom: "2026-07-27",
        dateTo: "2026-07-27",
        pump: "BOMBA_2",
        shiftType: "MANHA",
        category: "PRODUTIVO",
        clientId: "client-1",
        includeDeleted: false
      }
    });

    expect(result.map((item) => item.id)).toEqual(["matching"]);
  });

  it("does not silently truncate matching operational history", () => {
    const items = Array.from({ length: 250 }, (_, index) => ({
      id: `event-${String(index).padStart(3, "0")}`,
      startAt: new Date(2026, 6, 27, 12, 0, index),
      endAt: new Date(2026, 6, 27, 12, 1, index),
      createdAt: new Date(2026, 6, 27, 12, 2, index),
      shiftDate: "2026-07-27",
      pump: "BOMBA_1",
      shiftType: "MANHA",
      category: "PRODUTIVO",
      clientId: "client-1",
      containerStatus: "FULL",
      createdByUid: "operator-1",
      deleted: false
    }));

    const result = filterAndSortOperationalHistory(items, {
      role: "OPERATOR",
      uid: "operator-1",
      filters: {}
    });

    expect(result).toHaveLength(250);
  });

  it("filters a non-matching container status", () => {
    const result = filterAndSortOperationalHistory(
      [
        {
          id: "partial",
          startAt: 1,
          shiftDate: "2026-07-27",
          pump: "BOMBA_1",
          shiftType: "MANHA",
          category: "PRODUTIVO",
          clientId: "client-1",
          containerStatus: "PARTIAL",
          createdByUid: "operator-1",
          deleted: false
        }
      ],
      {
        role: "ADMIN",
        uid: "admin-1",
        filters: { containerStatus: "FULL" }
      }
    );

    expect(result).toEqual([]);
  });
});
