import { describe, expect, it } from "vitest";
import { documentDeadline, documentHasExpired } from "@/lib/domain/document-retention";

describe("document retention", () => {
  it.each([
    ["2024-02-29T09:10:11.012Z", "2025-02-28T09:10:11.012Z"],
    ["2023-03-31T23:59:59.999Z", "2024-03-31T23:59:59.999Z"],
    ["2023-02-28T00:00:00.000Z", "2024-02-28T00:00:00.000Z"],
    ["2026-12-31T23:59:59.999Z", "2027-12-31T23:59:59.999Z"],
    ["2024-02-29T23:00:00-03:00", "2025-03-01T02:00:00.000Z"],
  ])("preserves UTC time and clamps leap day for %s", (closed, expected) => {
    expect(documentDeadline(closed)).toBe(expected);
  });
  it("rejects invalid closure dates", () => {
    expect(() => documentDeadline("not-a-date")).toThrow("Data de encerramento inválida");
  });
  it("expires exactly at the deadline, without inferring missing dates", () => {
    const value = { documentExpiresAtIso: "2025-02-28T09:10:11.012Z" };
    const instant = Date.parse(value.documentExpiresAtIso);
    expect(documentHasExpired(value, instant - 1)).toBe(false);
    expect(documentHasExpired(value, instant)).toBe(true);
    expect(documentHasExpired({}, instant)).toBe(false);
    expect(documentHasExpired({ documentExpiresAtIso: null }, instant)).toBe(false);
    expect(documentHasExpired({ documentExpiresAtIso: "unknown" }, instant)).toBe(false);
  });
});
