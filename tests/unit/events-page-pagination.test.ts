import { describe, expect, it } from "vitest";
import {
  mergeEventPageItems,
  toEventPageQuery
} from "@/app/(app)/events/event-model";
import { EventListFilters } from "@/lib/ui/filters";

const filters: EventListFilters = {
  dateFrom: "2026-07-28",
  dateTo: "2026-07-29",
  pump: "BOMBA_1",
  shiftType: "",
  category: "",
  clientId: "",
  containerStatus: "",
  includeDeleted: false
};

describe("paginação do histórico de lançamentos", () => {
  it("associa o cursor aos filtros aplicados", () => {
    const query = new URLSearchParams(
      toEventPageQuery(filters, "cursor/with+symbols=")
    );

    expect(query.get("dateFrom")).toBe("2026-07-28");
    expect(query.get("dateTo")).toBe("2026-07-29");
    expect(query.get("pump")).toBe("BOMBA_1");
    expect(query.get("cursor")).toBe("cursor/with+symbols=");
  });

  it("faz append imutável e elimina sobreposição entre páginas", () => {
    const firstPage = [
      { id: "event-1", value: "first" },
      { id: "event-2", value: "stale" }
    ];
    const secondPage = [
      { id: "event-2", value: "fresh" },
      { id: "event-3", value: "third" }
    ];

    const merged = mergeEventPageItems(firstPage, secondPage);

    expect(merged).toEqual([
      { id: "event-1", value: "first" },
      { id: "event-2", value: "fresh" },
      { id: "event-3", value: "third" }
    ]);
    expect(firstPage).toEqual([
      { id: "event-1", value: "first" },
      { id: "event-2", value: "stale" }
    ]);
    expect(merged).not.toBe(firstPage);
  });
});
