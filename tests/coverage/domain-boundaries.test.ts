import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  calculateContainerCheckDigit,
  formatContainerForInput,
  formatPlateForInput,
  normalizeContainer,
  normalizePlate
} from "@/lib/domain/identifiers";
import {
  collectChangedFields,
  ensureShiftType,
  roleCanAccessClients,
  roleCanAccessUsers,
  validateEventInput
} from "@/lib/domain/validation";
import {
  defaultLast7DaysRange,
  inclusiveDaysBetween,
  parseDrilldownParams,
  parseExportMode,
  parseReportsFilters
} from "@/lib/server/reports-filters";

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    pump: "BOMBA_1",
    shiftDate: "2026-07-27",
    shiftType: "MANHA",
    startTime: "06:00",
    endTime: "06:20",
    category: "OUTROS",
    clientId: null,
    plate: null,
    container: null,
    notes: "Motivo operacional",
    ...overrides
  };
}

describe("domain input boundaries", () => {
  it("formats partial plate and container input without claiming validity", () => {
    expect(formatPlateForInput("abc")).toBe("ABC");
    expect(formatPlateForInput("abc1234")).toBe("ABC-1234");
    expect(formatPlateForInput("abc1d23")).toBe("ABC-1D23");
    expect(formatContainerForInput("abcu")).toBe("ABCU");
    expect(formatContainerForInput("abcu1234560")).toBe("ABCU 123456-0");
    expect(normalizePlate(null)).toBeNull();
    expect(normalizeContainer(" ")).toBeNull();
  });

  it("rejects invalid identifier shapes and unsupported characters", () => {
    expect(() => normalizePlate("AB123")).toThrow("Placa inválida");
    expect(() => normalizePlate("ABC12@4")).toThrow("Placa inválida");
    expect(() => normalizeContainer("ABCX1234560")).toThrow("Prefixo");
    expect(() => normalizeContainer("ABCU12345A0")).toThrow(
      "devem ser numéricos"
    );
    expect(() => calculateContainerCheckDigit("ABC?123456")).toThrow(
      "Código de container inválido"
    );
  });

  it("covers category-dependent validation and night-shift rollover", () => {
    expect(() =>
      validateEventInput(validInput({ category: "OUTROS", notes: null }))
    ).toThrow("Observação obrigatória");
    expect(() =>
      validateEventInput(
        validInput({ category: "EM_TRANSITO", clientId: null, plate: null })
      )
    ).toThrow("Cliente obrigatório");
    expect(() =>
      validateEventInput(
        validInput({
          category: "EM_TRANSITO",
          clientId: "client",
          plate: null
        })
      )
    ).toThrow("Placa obrigatória");
    expect(() =>
      validateEventInput(validInput({ startTime: "bad" }))
    ).toThrow("HH:MM");
    expect(() =>
      validateEventInput(
        validInput({ startTime: "07:00", endTime: "06:00" })
      )
    ).toThrow("início deve ser menor");

    const night = validateEventInput(
      validInput({
        shiftType: "NOITE",
        startTime: "23:50",
        endTime: "00:10"
      })
    );
    expect(night.durationMinutes).toBe(20);
  });

  it("validates container lifecycle branches", () => {
    expect(() =>
      validateEventInput(
        validInput({
          category: "PRODUTIVO",
          clientId: "client",
          plate: "ABC1234",
          container: "ABCU1234560",
          containerStatus: "BLEND_PARTIAL",
          containerReason: "Complemento",
          startsNewContainerCycle: true,
          blendConfirmed: true,
          notes: null
        })
      )
    ).toThrow("novo ciclo");

    const partial = validateEventInput(
      validInput({
        category: "PRODUTIVO",
        clientId: "client",
        plate: "ABC1234",
        container: "ABCU1234560",
        containerStatus: "PARTIAL",
        containerReason: " Complemento ",
        expectedContainerStateVersion: 2,
        notes: null
      })
    );
    expect(partial.event).toMatchObject({
      containerStatus: "PARTIAL",
      containerReason: "Complemento",
      expectedContainerStateVersion: 2
    });
  });

  it("reports only real changed fields and enforces role boundaries", () => {
    expect(
      collectChangedFields(
        { name: "same", nullable: undefined, old: 1 },
        { name: "same", nullable: null, old: 2, added: true }
      )
    ).toEqual({
      changedFields: ["old", "added"],
      before: { old: 1, added: null },
      after: { old: 2, added: true }
    });
    expect(roleCanAccessUsers("ADMIN")).toBe(true);
    expect(roleCanAccessUsers("SUPERVISOR")).toBe(false);
    expect(roleCanAccessClients("ADMIN")).toBe(true);
    expect(roleCanAccessClients("OPERATOR")).toBe(false);
    expect(ensureShiftType("MANHA")).toBe("MANHA");
    expect(ensureShiftType("NOITE")).toBe("NOITE");
    expect(() => ensureShiftType("TARDE")).toThrow("Turno inválido");
  });
});

describe("reports query boundaries", () => {
  it("builds default and inclusive date windows", () => {
    const now = DateTime.fromISO("2026-07-28T10:00:00", {
      zone: "America/Sao_Paulo"
    });
    expect(defaultLast7DaysRange(now)).toEqual({
      dateFrom: "2026-07-22",
      dateTo: "2026-07-28"
    });
    expect(inclusiveDaysBetween("2026-07-22", "2026-07-28")).toBe(7);
    expect(
      Number.isNaN(inclusiveDaysBetween("invalid", "2026-07-28"))
    ).toBe(true);
  });

  it("parses all supported dimensions and administrative deletion scope", () => {
    const filters = parseReportsFilters(
      new URLSearchParams({
        dateFrom: "2026-07-01",
        dateTo: "2026-07-28",
        granularity: "week",
        pump: "BOMBA_3",
        shiftType: "NOITE",
        category: "MANUTENCAO",
        clientId: " client ",
        containerStatus: "BUFFER",
        includeDeleted: "true"
      }),
      { allowIncludeDeleted: true }
    );
    expect(filters).toMatchObject({
      granularity: "week",
      pump: "BOMBA_3",
      shiftType: "NOITE",
      category: "MANUTENCAO",
      clientId: " client ",
      containerStatus: "BUFFER",
      includeDeleted: true
    });
    expect(
      parseReportsFilters(
        new URLSearchParams({ includeDeleted: "true" }),
        { allowIncludeDeleted: false }
      ).includeDeleted
    ).toBe(false);
  });

  it("rejects invalid and excessive report windows", () => {
    expect(() =>
      parseReportsFilters(
        new URLSearchParams({
          dateFrom: "2026-01-01",
          dateTo: "2026-07-28"
        }),
        { allowIncludeDeleted: true }
      )
    ).toThrow("90 dias");
    expect(() =>
      parseReportsFilters(
        new URLSearchParams({
          dateFrom: "2026-07-29",
          dateTo: "2026-07-28"
        }),
        { allowIncludeDeleted: true }
      )
    ).toThrow();
  });

  it("parses drilldown pagination and export modes defensively", () => {
    expect(
      parseDrilldownParams(
        new URLSearchParams({
          source: "chart",
          cursor: "20",
          limit: "200"
        })
      )
    ).toEqual({
      source: "chart",
      cursor: 20,
      limit: 100
    });
    expect(
      parseDrilldownParams(new URLSearchParams({ cursor: "-1", limit: "0" }))
    ).toEqual({
      source: "kpi",
      cursor: 0,
      limit: 1
    });
    expect(parseExportMode(new URLSearchParams())).toBe("detailed");
    expect(
      parseExportMode(new URLSearchParams({ mode: "aggregated" }))
    ).toBe("aggregated");
  });
});
