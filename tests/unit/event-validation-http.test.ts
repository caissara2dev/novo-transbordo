import { describe, expect, it } from "vitest";
import { validateEventInput } from "@/lib/domain/validation";
import { eventMutationBodySchema } from "@/lib/server/event-request-schemas";
import { fail } from "@/lib/server/http";

describe("event semantic validation HTTP contract", () => {
  it("returns a validation envelope instead of an internal error", async () => {
    let validationError: unknown;

    try {
      validateEventInput({
        pump: "BOMBA_1",
        shiftDate: "2026-07-28",
        shiftType: "MANHA",
        startTime: "06:00",
        endTime: "06:20",
        category: "PRODUTIVO",
        clientId: "client-1",
        plate: null,
        container: "ABCU1234560",
        notes: null
      });
    } catch (error) {
      validationError = error;
    }

    const response = fail(validationError);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Placa obrigatória para esta categoria."
      }
    });
  });

  it("accepts the explicit source contract and rejects undeclared fields", () => {
    const payload = {
      pump: "BOMBA_1",
      shiftDate: "2026-07-28",
      shiftType: "MANHA",
      startTime: "06:00",
      endTime: "06:20",
      category: "PRODUTIVO",
      clientId: "client-1",
      plate: null,
      container: "ABCU1234560",
      containerStatus: "FULL",
      loadSourceType: "BUFFER_CONTAINER",
      sourceContainer: "MSCU6639870",
      sourceContainerEmptied: true,
      expectedSourceContainerStateVersion: 4,
      expectedContainerStateVersion: 0,
      notes: null
    } as const;

    expect(eventMutationBodySchema.parse(payload)).toMatchObject({
      sourceContainer: "MSCU6639870",
      sourceContainerEmptied: true,
      expectedSourceContainerStateVersion: 4
    });
    expect(() =>
      eventMutationBodySchema.parse({ ...payload, sourceWeightKg: 12000 })
    ).toThrow();
    expect(() => validateEventInput({ ...payload, expectedContainerStateVersion: null })).toThrow("container de destino");
    expect(() => validateEventInput({ ...payload, expectedContainerStateVersion: undefined })).toThrow("container de destino");
    expect(validateEventInput(payload).event.expectedContainerStateVersion).toBe(0);
  });
});
