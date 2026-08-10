import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { HttpError } from "@/lib/domain/errors";

const authMocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  ensureApproved: vi.fn(),
  ensureRole: vi.fn()
}));

const serviceMocks = vi.hoisted(() => ({
  listInternalCheckins: vi.fn(),
  getInternalCheckin: vi.fn(),
  assignInternalCheckinClient: vi.fn(),
  transitionInternalCheckin: vi.fn(),
  cancelInternalCheckin: vi.fn(),
  correctInternalCheckin: vi.fn(),
  overrideInternalCheckinLocation: vi.fn()
}));

const adapterMocks = vi.hoisted(() => ({
  includeIdempotently: vi.fn(),
  updateIdempotently: vi.fn()
}));

const officialMutationMocks = vi.hoisted(() => ({
  reserveOfficialCorrection: vi.fn(),
  commitOfficialCorrection: vi.fn(),
  reserveOfficialLocationOverride: vi.fn(),
  commitOfficialLocationOverride: vi.fn(),
  markOfficialMutationFailure: vi.fn()
}));

vi.mock("@/lib/server/auth", () => authMocks);
vi.mock("@/lib/server/checkins/internal-service", () => serviceMocks);
vi.mock(
  "@/lib/server/checkins/official-mutation",
  () => officialMutationMocks
);
vi.mock("@/lib/server/checkins/power-automate-adapter", () => ({
  createPowerAutomateCheckinAdapterFromEnv: vi.fn(() => adapterMocks)
}));

type TestRole = "OPERATOR" | "SUPERVISOR" | "ADMIN";

const authContext = {
  uid: "user-1",
  email: "user@line.test",
  profile: {
    role: "SUPERVISOR" as TestRole,
    approved: true,
    active: true
  }
};

function request(path: string, method = "GET", body?: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" }
        })
  });
}

function context(id = "11111111-1111-4111-8111-111111111111") {
  return { params: Promise.resolve({ id }) };
}

function managerDetail(status = "AGUARDANDO_LIBERACAO") {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    publicCode: "LT-23456789",
    status,
    version: 3,
    driverName: "Joao da Silva",
    driverLicense: "02650306461",
    driverPhone: "13999999999",
    plate: "ABC1D23",
    carrierName: "Transportadora",
    vehicleType: "Bitrem",
    product: "Produto",
    originPlant: "Usina",
    originInvoiceNumbers: "123",
    remittanceInvoiceNumber: "456",
    whatsappNoticeAccepted: true,
    queueLocationAccepted: true
  };
}

describe("internal check-in HTTP routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authContext.profile.role = "SUPERVISOR";
    authMocks.requireAuth.mockResolvedValue(authContext);
    authMocks.ensureRole.mockImplementation(
      (profile: { role: TestRole }, allowed: TestRole[]) => {
        if (!allowed.includes(profile.role)) {
          throw new HttpError(403, "Permissão insuficiente.");
        }
      }
    );
    serviceMocks.listInternalCheckins.mockResolvedValue([
      { id: "checkin-1", plate: "ABC1D23", status: "CHAMADO" }
    ]);
    serviceMocks.getInternalCheckin.mockResolvedValue(managerDetail());
    serviceMocks.assignInternalCheckinClient.mockResolvedValue(managerDetail());
    serviceMocks.transitionInternalCheckin.mockResolvedValue(managerDetail("CHAMADO"));
    serviceMocks.cancelInternalCheckin.mockResolvedValue(managerDetail("CANCELADO"));
    serviceMocks.correctInternalCheckin.mockResolvedValue(managerDetail());
    serviceMocks.overrideInternalCheckinLocation.mockResolvedValue(
      managerDetail("AGUARDANDO_LIBERACAO")
    );
    adapterMocks.updateIdempotently.mockResolvedValue({
      confirmedAtIso: "2026-08-10T12:00:01.000Z"
    });
    adapterMocks.includeIdempotently.mockResolvedValue({
      confirmedAtIso: "2026-08-10T12:00:01.000Z"
    });
    officialMutationMocks.reserveOfficialCorrection.mockResolvedValue({
      kind: "CORRECTION",
      token: "test-1",
      publicCode: "LT-23456789",
      reservedVersion: 4,
      idempotencyKey: "LT-23456789:v4",
      patch: { plate: "BRA-2E19" }
    });
    officialMutationMocks.reserveOfficialLocationOverride.mockResolvedValue({
      kind: "LOCATION_OVERRIDE",
      token: "test-2",
      publicCode: "LT-23456789",
      reservedVersion: 4,
      form: {
        driverName: "Joao da Silva",
        driverLicense: "02650306461",
        driverPhone: "13999999999",
        plate: "ABC-1D23",
        carrierName: "Transportadora",
        vehicleType: "Bitrem",
        product: "Produto",
        originPlant: "Usina",
        originInvoiceNumbers: "123",
        remittanceInvoiceNumber: "456",
        whatsappNoticeAccepted: true,
        queueLocationAccepted: true
      }
    });
  });

  it("authenticates an operator and delegates the minimal queue DTO to the service", async () => {
    authContext.profile.role = "OPERATOR";
    const route = await import("@/app/api/checkins/route");

    const response = await route.GET(
      request("/api/checkins?status=CHAMADO&status=AGUARDANDO_CHAMADA")
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: { items: [{ id: "checkin-1", plate: "ABC1D23" }] }
    });
    expect(authMocks.ensureApproved).toHaveBeenCalledWith(authContext.profile);
    expect(serviceMocks.listInternalCheckins).toHaveBeenCalledWith({
      actor: { uid: "user-1", role: "OPERATOR" },
      statuses: ["CHAMADO", "AGUARDANDO_CHAMADA"]
    });
  });

  it("does not expose check-ins when authentication fails", async () => {
    authMocks.requireAuth.mockRejectedValueOnce(
      new HttpError(401, "Não autenticado.")
    );
    const route = await import("@/app/api/checkins/route");

    const response = await route.GET(request("/api/checkins"));

    expect(response.status).toBe(401);
    expect(serviceMocks.listInternalCheckins).not.toHaveBeenCalled();
  });

  it("rejects unknown query parameters instead of silently ignoring them", async () => {
    const route = await import("@/app/api/checkins/route");

    const response = await route.GET(request("/api/checkins?includeSensitive=true"));

    expect(response.status).toBe(400);
    expect(serviceMocks.listInternalCheckins).not.toHaveBeenCalled();
  });

  it("returns the role-scoped detail through the standard envelope", async () => {
    const route = await import("@/app/api/checkins/[id]/route");

    const response = await route.GET(
      request("/api/checkins/checkin-1"),
      context("checkin-1")
    );

    expect(response.status).toBe(200);
    expect(serviceMocks.getInternalCheckin).toHaveBeenCalledWith({
      actor: { uid: "user-1", role: "SUPERVISOR" },
      checkinId: "checkin-1"
    });
  });

  it("blocks operator mutations before any service or official-record call", async () => {
    authContext.profile.role = "OPERATOR";
    const route = await import("@/app/api/checkins/[id]/route");

    const response = await route.PATCH(
      request("/api/checkins/checkin-1", "PATCH", {
        action: "ASSIGN_CLIENT",
        clientId: "client-1",
        expectedVersion: 3,
        reason: "Cliente confirmado"
      }),
      context("checkin-1")
    );

    expect(response.status).toBe(403);
    expect(serviceMocks.assignInternalCheckinClient).not.toHaveBeenCalled();
    expect(adapterMocks.updateIdempotently).not.toHaveBeenCalled();
  });

  it("uses server time and a strict assignment contract", async () => {
    const route = await import("@/app/api/checkins/[id]/route");
    const invalid = await route.PATCH(
      request("/api/checkins/checkin-1", "PATCH", {
        action: "ASSIGN_CLIENT",
        clientId: "client-1",
        expectedVersion: 3,
        reason: "Cliente confirmado",
        nowIso: "2000-01-01T00:00:00.000Z"
      }),
      context("checkin-1")
    );

    expect(invalid.status).toBe(400);
    expect(serviceMocks.assignInternalCheckinClient).not.toHaveBeenCalled();

    const valid = await route.PATCH(
      request("/api/checkins/checkin-1", "PATCH", {
        action: "ASSIGN_CLIENT",
        clientId: "client-1",
        expectedVersion: 3,
        reason: "Cliente confirmado"
      }),
      context("checkin-1")
    );
    expect(valid.status).toBe(200);
    expect(serviceMocks.assignInternalCheckinClient).toHaveBeenCalledWith(
      expect.objectContaining({
        checkinId: "checkin-1",
        nowIso: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)
      })
    );
  });

  it("validates transition and cancellation payloads strictly", async () => {
    const transitionRoute = await import(
      "@/app/api/checkins/[id]/transitions/route"
    );
    const cancelRoute = await import("@/app/api/checkins/[id]/cancel/route");

    const transition = await transitionRoute.POST(
      request("/api/checkins/checkin-1/transitions", "POST", {
        toStatus: "CHAMADO",
        expectedVersion: 3,
        reason: "Liberado pela equipe"
      }),
      context("checkin-1")
    );
    const invalidCancel = await cancelRoute.POST(
      request("/api/checkins/checkin-1/cancel", "POST", {
        expectedVersion: 3,
        reason: "",
        proof: { confirmedAtIso: "2026-08-10T12:00:00.000Z" }
      }),
      context("checkin-1")
    );

    expect(transition.status).toBe(200);
    expect(serviceMocks.transitionInternalCheckin).toHaveBeenCalledWith(
      expect.objectContaining({ toStatus: "CHAMADO", checkinId: "checkin-1" })
    );
    expect(invalidCancel.status).toBe(400);
    expect(serviceMocks.cancelInternalCheckin).not.toHaveBeenCalled();
  });

  it("corrects a pre-registration without touching Excel", async () => {
    serviceMocks.getInternalCheckin.mockResolvedValueOnce(
      managerDetail("PRE_CADASTRO")
    );
    const route = await import("@/app/api/checkins/[id]/route");

    const response = await route.PATCH(
      request("/api/checkins/checkin-1", "PATCH", {
        action: "CORRECT",
        expectedVersion: 3,
        reason: "Telefone corrigido",
        patch: { driverPhone: "13988887777" }
      }),
      context("checkin-1")
    );

    expect(response.status).toBe(200);
    expect(adapterMocks.updateIdempotently).not.toHaveBeenCalled();
    expect(serviceMocks.correctInternalCheckin).toHaveBeenCalledWith(
      expect.objectContaining({ patch: { driverPhone: "13988887777" } })
    );
  });

  it("reserves a post-check-in correction before updating the official row", async () => {
    const route = await import("@/app/api/checkins/[id]/route");

    const response = await route.PATCH(
      request("/api/checkins/checkin-1", "PATCH", {
        action: "CORRECT",
        expectedVersion: 3,
        reason: "Placa corrigida",
        patch: { plate: "BRA2E19" }
      }),
      context("checkin-1")
    );

    expect(response.status).toBe(200);
    expect(adapterMocks.updateIdempotently).toHaveBeenCalledWith(
      expect.objectContaining({
        publicCode: "LT-23456789",
        idempotencyKey: "LT-23456789:v4",
        patch: { plate: "BRA-2E19" }
      })
    );
    expect(officialMutationMocks.reserveOfficialCorrection).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: 3, patch: { plate: "BRA-2E19" } })
    );
    expect(officialMutationMocks.commitOfficialCorrection).toHaveBeenCalledWith({
      checkinId: "checkin-1",
      token: "test-1",
      confirmedAtIso: "2026-08-10T12:00:01.000Z"
    });
    expect(
      officialMutationMocks.reserveOfficialCorrection.mock.invocationCallOrder[0]
    ).toBeLessThan(adapterMocks.updateIdempotently.mock.invocationCallOrder[0]);
    expect(
      adapterMocks.updateIdempotently.mock.invocationCallOrder[0]
    ).toBeLessThan(
      officialMutationMocks.commitOfficialCorrection.mock.invocationCallOrder[0]
    );
  });

  it("rejects a client-supplied correction proof", async () => {
    const route = await import("@/app/api/checkins/[id]/route");

    const response = await route.PATCH(
      request("/api/checkins/checkin-1", "PATCH", {
        action: "CORRECT",
        expectedVersion: 3,
        reason: "Placa corrigida",
        patch: { plate: "BRA2E19" },
        officialRecordConfirmation: {
          confirmedAtIso: "2026-08-10T12:00:01.000Z"
        }
      }),
      context("checkin-1")
    );

    expect(response.status).toBe(400);
    expect(serviceMocks.getInternalCheckin).not.toHaveBeenCalled();
    expect(adapterMocks.updateIdempotently).not.toHaveBeenCalled();
    expect(serviceMocks.correctInternalCheckin).not.toHaveBeenCalled();
  });

  it("keeps the reserved correction retryable when Excel is unavailable", async () => {
    adapterMocks.updateIdempotently.mockRejectedValueOnce(
      new HttpError(503, "Registro oficial indisponível.")
    );
    const route = await import("@/app/api/checkins/[id]/route");

    const response = await route.PATCH(
      request("/api/checkins/checkin-1", "PATCH", {
        action: "CORRECT",
        expectedVersion: 3,
        reason: "Placa corrigida",
        patch: { plate: "BRA2E19" }
      }),
      context("checkin-1")
    );

    expect(response.status).toBe(503);
    expect(officialMutationMocks.markOfficialMutationFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        checkinId: "checkin-1",
        token: "test-1"
      })
    );
    expect(officialMutationMocks.commitOfficialCorrection).not.toHaveBeenCalled();
  });

  it("rejects a normalized no-op correction before updating Excel", async () => {
    const route = await import("@/app/api/checkins/[id]/route");

    const response = await route.PATCH(
      request("/api/checkins/checkin-1", "PATCH", {
        action: "CORRECT",
        expectedVersion: 3,
        reason: "Tentativa sem mudança",
        patch: { plate: "ABC1D23" }
      }),
      context("checkin-1")
    );

    expect(response.status).toBe(400);
    expect(adapterMocks.updateIdempotently).not.toHaveBeenCalled();
    expect(serviceMocks.correctInternalCheckin).not.toHaveBeenCalled();
  });

  it("reserves a location override before creating the official row", async () => {
    serviceMocks.getInternalCheckin.mockResolvedValueOnce(
      managerDetail("PRE_CADASTRO")
    );
    const route = await import(
      "@/app/api/checkins/[id]/location-override/route"
    );

    const response = await route.POST(
      request("/api/checkins/checkin-1/location-override", "POST", {
        expectedVersion: 3,
        justification: "GPS do aparelho indisponivel"
      }),
      context("checkin-1")
    );

    expect(response.status).toBe(200);
    expect(adapterMocks.includeIdempotently).toHaveBeenCalledWith(
      expect.objectContaining({
        publicCode: "LT-23456789",
        form: expect.objectContaining({ plate: "ABC-1D23" })
      })
    );
    expect(
      officialMutationMocks.reserveOfficialLocationOverride
    ).toHaveBeenCalledWith(
      expect.objectContaining({ justification: "GPS do aparelho indisponivel" })
    );
    expect(
      officialMutationMocks.commitOfficialLocationOverride
    ).toHaveBeenCalledWith({
      checkinId: "checkin-1",
      token: "test-2",
      confirmedAtIso: "2026-08-10T12:00:01.000Z"
    });
  });

  it("rejects a client-supplied location-override proof", async () => {
    const route = await import(
      "@/app/api/checkins/[id]/location-override/route"
    );

    const response = await route.POST(
      request("/api/checkins/checkin-1/location-override", "POST", {
        expectedVersion: 3,
        justification: "GPS indisponivel",
        confirmation: { confirmedAtIso: "2026-08-10T12:00:01.000Z" }
      }),
      context("checkin-1")
    );

    expect(response.status).toBe(400);
    expect(adapterMocks.includeIdempotently).not.toHaveBeenCalled();
    expect(serviceMocks.overrideInternalCheckinLocation).not.toHaveBeenCalled();
  });

  it("rejects a location override outside pre-registration before Excel", async () => {
    serviceMocks.getInternalCheckin.mockResolvedValueOnce(
      managerDetail("AGUARDANDO_LIBERACAO")
    );
    officialMutationMocks.reserveOfficialLocationOverride.mockRejectedValueOnce(
      new HttpError(409, "Exceção de localização não permitida neste estado.")
    );
    const route = await import(
      "@/app/api/checkins/[id]/location-override/route"
    );

    const response = await route.POST(
      request("/api/checkins/checkin-1/location-override", "POST", {
        expectedVersion: 3,
        justification: "GPS indisponivel"
      }),
      context("checkin-1")
    );

    expect(response.status).toBe(409);
    expect(adapterMocks.includeIdempotently).not.toHaveBeenCalled();
    expect(
      officialMutationMocks.commitOfficialLocationOverride
    ).not.toHaveBeenCalled();
  });
});
