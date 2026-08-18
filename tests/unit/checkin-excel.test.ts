import { describe, expect, it } from "vitest";
import { toSafeExcelText } from "@/lib/domain/checkin-excel";

describe("check-in Excel cell safety", () => {
  it.each([
    ["=1+1", "'=1+1"],
    ["+SUM(A1:A2)", "'+SUM(A1:A2)"],
    ["-2+3", "'-2+3"],
    ["@IMPORTDATA(x)", "'@IMPORTDATA(x)"],
    ["\t=cmd", "'=cmd"],
    ["  =cmd", "'  =cmd"]
  ])("neutralizes formula-like input %s", (input, expected) => {
    expect(toSafeExcelText(input)).toBe(expected);
  });

  it("removes control characters and preserves ordinary logistics text", () => {
    expect(toSafeExcelText("Glicerina\u0000 bruta\nNF 123")).toBe(
      "Glicerina bruta\nNF 123"
    );
    expect(toSafeExcelText("Usina São Paulo")).toBe("Usina São Paulo");
  });
});
