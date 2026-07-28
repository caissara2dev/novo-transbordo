import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { canEdit, validateEventInput } from "@/lib/domain/validation";
import {
  calculateDurationMinutes,
  computeWindowCheck,
  currentShiftFromNow,
  isValidHHMM,
  normalizeUpper,
  parseTimeToMinutes,
  resolveTimelineDate
} from "@/lib/domain/time";
import {
  assertExpectedContainerStateVersion,
  compareOperationalOrder,
  resolveContainerTransition
} from "@/lib/server/container-states";

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

  it("covers morning, evening and time-format boundaries", () => {
    const morning = DateTime.fromISO("2026-02-07T10:00:00", {
      zone: "America/Sao_Paulo"
    });
    const evening = DateTime.fromISO("2026-02-07T18:00:00", {
      zone: "America/Sao_Paulo"
    });

    expect(currentShiftFromNow(morning)).toEqual({
      shiftDate: "2026-02-07",
      shiftType: "MANHA"
    });
    expect(currentShiftFromNow(evening)).toEqual({
      shiftDate: "2026-02-07",
      shiftType: "NOITE"
    });
    expect(isValidHHMM("23:59")).toBe(true);
    expect(isValidHHMM("24:00")).toBe(false);
    expect(parseTimeToMinutes("01:30")).toBe(90);
    expect(computeWindowCheck("MANHA", "06:00")).toBe(true);
    expect(computeWindowCheck("MANHA", "05:59")).toBe(false);
    expect(computeWindowCheck("NOITE", "23:00")).toBe(true);
    expect(computeWindowCheck("NOITE", "00:30")).toBe(true);
    expect(computeWindowCheck("NOITE", "10:00")).toBe(false);
  });

  it("normalizes optional text and calculates cross-midnight duration", () => {
    expect(normalizeUpper(null)).toBeNull();
    expect(normalizeUpper("   ")).toBeNull();
    expect(normalizeUpper(" abc ")).toBe("ABC");
    expect(
      calculateDurationMinutes(
        "2026-02-06T23:50:00-03:00",
        "2026-02-07T00:10:00-03:00"
      )
    ).toBe(20);
    expect(
      resolveTimelineDate("2026-02-06", "NOITE", "23:00").toISODate()
    ).toBe("2026-02-06");
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
    ).toThrow("Observação obrigatória");
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
    expect(validated.event.containerStatus).toBe("FULL");
  });

  it("accepts Bomba 3 with the same operational rules", () => {
    const validated = validateEventInput({
      pump: "BOMBA_3",
      shiftDate: "2026-02-06",
      shiftType: "MANHA",
      startTime: "06:00",
      endTime: "07:00",
      category: "PRODUTIVO",
      clientId: "abc",
      plate: "ABC1234",
      container: "ABCU1234560",
      notes: null
    });

    expect(validated.event.pump).toBe("BOMBA_3");
  });

  it("requires a reason for Partial, Buffer and partial Blend", () => {
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
        container: "ABCU1234560",
        containerStatus: "PARTIAL",
        containerReason: " ",
        notes: null
      })
    ).toThrow("Motivo do estado");
  });

  it("requires explicit Blend confirmation", () => {
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
        container: "ABCU1234560",
        containerStatus: "BLEND_FULL",
        blendConfirmed: false,
        notes: null
      })
    ).toThrow("Confirme a formação");
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
    ).toThrow("Dígito verificador incorreto");
  });

  it("checks edit permission window", () => {
    const now = 1_000_000;
    expect(canEdit("SUPERVISOR", now - 10_000, now)).toBe(true);
    expect(canEdit("SUPERVISOR", now - 90_000_000, now)).toBe(false);
    expect(canEdit("ADMIN", now - 90_000_000, now)).toBe(true);
    expect(canEdit("OPERATOR", now - 1_000, now)).toBe(false);
  });
});

describe("container lifecycle transitions", () => {
  const current = {
    container: "ABCU 123456-0",
    status: "PARTIAL",
    reason: "Aguardando complemento",
    cycleId: "cycle-1",
    latestEventId: "event-1",
    previousEventId: null,
    clientId: "client-1",
    clientNameSnapshot: "Cliente 1",
    plate: "ABC-1234",
    pump: "BOMBA_1",
    operationalAt: new Date("2026-02-06T10:00:00Z"),
    eventCreatedAt: new Date("2026-02-06T10:01:00Z"),
    version: 3,
    updatedAt: new Date("2026-02-06T10:01:00Z")
  } as const;

  it("links a same-client Blend to the previous Partial", () => {
    const result = resolveContainerTransition({
      current,
      status: "BLEND_FULL",
      clientId: "client-1",
      startsNewCycle: false
    });

    expect(result).toEqual({
      cycleId: "cycle-1",
      previousEventId: "event-1"
    });
  });

  it("blocks a cross-client Blend", () => {
    expect(() =>
      resolveContainerTransition({
        current,
        status: "BLEND_FULL",
        clientId: "client-2",
        startsNewCycle: false
      })
    ).toThrow("mesmo cliente");
  });

  it("blocks a direct Blend at the start of a new cycle", () => {
    expect(() =>
      resolveContainerTransition({
        current,
        status: "BLEND_PARTIAL",
        clientId: "client-1",
        startsNewCycle: true
      })
    ).toThrow("novo ciclo");
  });

  it("keeps a Blend when its partial cycle is completed", () => {
    const result = resolveContainerTransition({
      current: { ...current, status: "BLEND_PARTIAL" },
      status: "BLEND_FULL",
      clientId: "client-1",
      startsNewCycle: false
    });

    expect(result.cycleId).toBe("cycle-1");
    expect(result.previousEventId).toBe("event-1");
  });

  it("blocks a Blend returning to simple cargo in the same cycle", () => {
    expect(() =>
      resolveContainerTransition({
        current: { ...current, status: "BLEND_PARTIAL" },
        status: "FULL",
        clientId: "client-1",
        startsNewCycle: false
      })
    ).toThrow("não pode voltar");
  });

  it("requires a new-cycle confirmation after a full container", () => {
    expect(() =>
      resolveContainerTransition({
        current: { ...current, status: "FULL" },
        status: "PARTIAL",
        clientId: "client-1",
        startsNewCycle: false
      })
    ).toThrow("foi esvaziado");
  });

  it("rejects a stale state version like a second concurrent operator", () => {
    expect(() => assertExpectedContainerStateVersion(3, 4)).toThrow(
      "alterado por outro usuário"
    );
    expect(() => assertExpectedContainerStateVersion(4, 4)).not.toThrow();
  });

  it("orders current state by operational time and creation time only as a tiebreaker", () => {
    expect(
      compareOperationalOrder(
        new Date("2026-02-06T09:00:00Z"),
        new Date("2026-02-07T12:00:00Z"),
        current
      )
    ).toBeLessThan(0);

    expect(
      compareOperationalOrder(
        current.operationalAt,
        new Date("2026-02-06T10:02:00Z"),
        current
      )
    ).toBeGreaterThan(0);
  });
});
