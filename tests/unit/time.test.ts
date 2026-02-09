import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { canEdit, validateEventInput } from "@/lib/domain/validation";
import { currentShiftFromNow, resolveTimelineDate } from "@/lib/domain/time";

describe("domain time rules", () => {
  it("assigns NOITE 00:20 to next day timeline", () => {
    const dt = resolveTimelineDate("2026-02-06", "NOITE", "00:20");
    expect(dt.toISODate()).toBe("2026-02-07");
  });

  it("computes night shiftDate for early-morning clock", () => {
    const now = DateTime.fromISO("2026-02-07T00:30:00", { zone: "America/Sao_Paulo" });
    const shift = currentShiftFromNow(now);
    expect(shift.shiftType).toBe("NOITE");
    expect(shift.shiftDate).toBe("2026-02-06");
  });

  it("enforces duration bounds", () => {
    expect(() =>
      validateEventInput({
        pump: "BOMBA_1",
        shiftDate: "2026-02-06",
        shiftType: "MANHA",
        startTime: "06:00",
        endTime: "06:00",
        category: "PRODUTIVO",
        clientId: "abc",
        plate: "AAA-1234",
        container: "ABCU1234560",
        notes: null
      })
    ).toThrow();
  });

  it("validates conditional category fields", () => {
    expect(() =>
      validateEventInput({
        pump: "BOMBA_1",
        shiftDate: "2026-02-06",
        shiftType: "MANHA",
        startTime: "06:00",
        endTime: "07:00",
        category: "EM_TRANSITO",
        clientId: "abc",
        plate: "AAA-1234",
        container: null,
        notes: null
      })
    ).toThrow("Observacao obrigatoria");
  });

  it("accepts supported plate/container formats", () => {
    const validated = validateEventInput({
      pump: "BOMBA_1",
      shiftDate: "2026-02-06",
      shiftType: "MANHA",
      startTime: "06:00",
      endTime: "07:00",
      category: "PRODUTIVO",
      clientId: "abc",
      plate: "bbb1b23",
      container: "abcu1234560",
      notes: null
    });

    expect(validated.event.plate).toBe("BBB-1B23");
    expect(validated.event.container).toBe("ABCU 123456-0");
  });

  it("accepts old brazilian plate without separators", () => {
    const validated = validateEventInput({
      pump: "BOMBA_1",
      shiftDate: "2026-02-06",
      shiftType: "MANHA",
      startTime: "06:00",
      endTime: "07:00",
      category: "PRODUTIVO",
      clientId: "abc",
      plate: "abc1234",
      container: "ABCU 123456-0",
      notes: null
    });

    expect(validated.event.plate).toBe("ABC-1234");
  });

  it("rejects container with invalid check digit", () => {
    expect(() =>
      validateEventInput({
        pump: "BOMBA_1",
        shiftDate: "2026-02-06",
        shiftType: "MANHA",
        startTime: "06:00",
        endTime: "07:00",
        category: "PRODUTIVO",
        clientId: "abc",
        plate: "ABC1234",
        container: "ABCU1234569",
        notes: null
      })
    ).toThrow("Digito verificador incorreto");
  });

  it("checks edit permission window", () => {
    const now = 1_000_000;
    expect(canEdit("SUPERVISOR", now - 10_000, now)).toBe(true);
    expect(canEdit("SUPERVISOR", now - 90_000_000, now)).toBe(false);
    expect(canEdit("ADMIN", now - 90_000_000, now)).toBe(true);
    expect(canEdit("OPERATOR", now - 1_000, now)).toBe(false);
  });
});
