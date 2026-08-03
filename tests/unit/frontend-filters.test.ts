import { describe, expect, it } from "vitest";
import {
  filtersAreEqual,
  toEventListQuery,
  toReportQuery
} from "@/lib/ui/filters";

describe("frontend filter queries", () => {
  it("serializes only populated event filters", () => {
    const query = toEventListQuery({
      dateFrom: "2026-07-01",
      dateTo: "2026-07-28",
      pump: "BOMBA_1",
      shiftType: "",
      category: "PRODUTIVO",
      clientId: "",
      containerStatus: "FULL",
      includeDeleted: true
    });

    expect(query).toBe(
      "dateFrom=2026-07-01&dateTo=2026-07-28&pump=BOMBA_1&category=PRODUTIVO&containerStatus=FULL&includeDeleted=true"
    );
  });

  it("serializes the complete applied report period and omits empty optional filters", () => {
    const query = toReportQuery({
      dateFrom: "2026-07-22",
      dateTo: "2026-07-28",
      granularity: "day",
      pump: "",
      shiftType: "DAY",
      category: "",
      clientId: "client-1",
      containerStatus: "",
      includeDeleted: false
    });

    expect(query).toBe(
      "dateFrom=2026-07-22&dateTo=2026-07-28&granularity=day&shiftType=DAY&clientId=client-1"
    );
  });

  it("detects when applying a draft would repeat the active query", () => {
    const active = {
      dateFrom: "2026-07-22",
      dateTo: "2026-07-28",
      pump: "",
      shiftType: "DAY",
      category: "",
      clientId: "",
      containerStatus: "",
      includeDeleted: false
    };

    expect(filtersAreEqual(active, { ...active })).toBe(true);
    expect(filtersAreEqual(active, { ...active, pump: "BOMBA_2" })).toBe(false);
  });
});
