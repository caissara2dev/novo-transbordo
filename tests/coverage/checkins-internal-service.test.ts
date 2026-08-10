import { beforeEach, describe, expect, it, vi } from "vitest";
import { inMemoryAdminDb } from "./in-memory-firestore";

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: inMemoryAdminDb
}));

import {
  assignInternalCheckinClient,
  cancelInternalCheckin,
  correctInternalCheckin,
  getInternalCheckin,
  listInternalCheckins,
  overrideInternalCheckinLocation,
  transitionInternalCheckin
} from "@/lib/server/checkins/internal-service";

const NOW = "2026-08-10T18:00:00.000Z";
const MANAGER = {
  uid: "supervisor-1",
  role: "SUPERVISOR" as const
};
const OPERATOR = {
  uid: "operator-1",
  role: "OPERATOR" as const
};

function storedCheckin(overrides: Record<string, unknown> = {}) {
  return {
    id: "checkin-1",
    publicCode: "LT-23456789",
    source: "CARRIER",
    status: "AGUARDANDO_LIBERACAO",
    syncState: "CONFIRMADO",
    driverName: "Wallace Mendes",
    driverLicense: "05555930435",
    driverPhone: "44999197442",
    plate: "AYZ-5E53",
    carrierName: "Transrio",
    vehicleType: "Vanderleia",
    product: "Glicerina bruta",
    originPlant: "Petrobrás",
    originInvoiceNumbers: "95796",
    remittanceInvoiceNumber: "26947",
    whatsappNoticeAccepted: true,
    queueLocationAccepted: true,
    driverLicenseIndex: "v1:cnh-index",
    driverPhoneIndex: "v1:phone-index",
    plateIndex: "v1:plate-index",
    geofence: {
      allowed: true,
      distanceMeters: 3_200,
      radiusMeters: 20_000,
      accuracyMeters: 35,
      validatedAtIso: "2026-08-10T17:50:00.000Z"
    },
    clientId: null,
    clientNameSnapshot: null,
    cancellationReason: null,
    version: 3,
    createdAtIso: "2026-08-10T15:00:00.000Z",
    updatedAtIso: "2026-08-10T17:50:00.000Z",
    confirmedAtIso: "2026-08-10T17:50:01.000Z",
    ...overrides
  };
}

function seedCheckin(overrides: Record<string, unknown> = {}) {
  const stored = storedCheckin(overrides);
  inMemoryAdminDb.seed("checkins", String(stored.id), stored);
  return stored;
}

describe("internal check-in service", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    inMemoryAdminDb.reset();
  });

  it("returns the minimum queue DTO to operators and the complete safe DTO to managers", async () => {
    seedCheckin();

    const operatorRows = await listInternalCheckins({ actor: OPERATOR });
    const managerRows = await listInternalCheckins({ actor: MANAGER });

    expect(operatorRows).toEqual([
      {
        id: "checkin-1",
        plate: "AYZ-5E53",
        driverName: "Wallace Mendes",
        carrierName: "Transrio",
        product: "Glicerina bruta",
        clientId: null,
        clientName: null,
        status: "AGUARDANDO_LIBERACAO",
        version: 3
      }
    ]);
    expect(JSON.stringify(operatorRows)).not.toMatch(/05555930435|44999197442|95796/);
    expect(managerRows[0]).toMatchObject({
      id: "checkin-1",
      publicCode: "LT-23456789",
      driverLicense: "05555930435",
      driverPhone: "44999197442",
      originInvoiceNumbers: "95796"
    });
    expect(JSON.stringify(managerRows)).not.toMatch(/cnh-index|phone-index|plate-index/);
  });

  it("keeps unconfirmed pre-registrations out of the operator queue", async () => {
    seedCheckin({ status: "PRE_CADASTRO", syncState: null });

    await expect(listInternalCheckins({ actor: OPERATOR })).resolves.toEqual([]);
    await expect(listInternalCheckins({ actor: MANAGER })).resolves.toHaveLength(1);
    await expect(
      getInternalCheckin({ actor: OPERATOR, checkinId: "checkin-1" })
    ).rejects.toMatchObject({ status: 404 });
  });

  it("limits operator details but includes revision metadata for managers", async () => {
    seedCheckin();
    inMemoryAdminDb.seed("checkins/checkin-1/revisions", "revision-1", {
      action: "CLIENT_ASSIGNED",
      actorUid: "supervisor-1",
      actorRole: "SUPERVISOR",
      reason: "Carga liberada pelo cliente",
      changedFields: ["clientId"],
      previousVersion: 2,
      newVersion: 3,
      createdAtIso: NOW
    });

    const operatorDetail = await getInternalCheckin({
      actor: OPERATOR,
      checkinId: "checkin-1"
    });
    const managerDetail = await getInternalCheckin({
      actor: MANAGER,
      checkinId: "checkin-1"
    });

    expect(operatorDetail).not.toHaveProperty("driverPhone");
    expect(operatorDetail).not.toHaveProperty("revisions");
    expect(managerDetail).toMatchObject({
      driverPhone: "44999197442",
      revisions: [{ action: "CLIENT_ASSIGNED", previousVersion: 2, newVersion: 3 }]
    });
  });

  it("assigns an active client transactionally and records a metadata-only revision", async () => {
    seedCheckin();
    inMemoryAdminDb.seed("clients", "client-1", {
      name: "Cliente Alfa",
      active: true
    });

    const result = await assignInternalCheckinClient({
      actor: MANAGER,
      checkinId: "checkin-1",
      clientId: "client-1",
      expectedVersion: 3,
      reason: "Identificação confirmada pela documentação",
      nowIso: NOW
    });

    expect(result).toMatchObject({
      clientId: "client-1",
      clientNameSnapshot: "Cliente Alfa",
      version: 4
    });
    expect(inMemoryAdminDb.entries("checkins/checkin-1/revisions")).toEqual([
      expect.arrayContaining([
        expect.any(String),
        expect.objectContaining({
          action: "CLIENT_ASSIGNED",
          actorUid: "supervisor-1",
          changedFields: ["clientId"],
          previousVersion: 3,
          newVersion: 4
        })
      ])
    ]);
    expect(JSON.stringify(inMemoryAdminDb.entries("checkins/checkin-1/revisions"))).not.toMatch(
      /05555930435|44999197442|AYZ-5E53/
    );
  });

  it("requires a client before moving to AGUARDANDO_CHAMADA and denies direct operator transitions", async () => {
    seedCheckin();

    await expect(
      transitionInternalCheckin({
        actor: MANAGER,
        checkinId: "checkin-1",
        toStatus: "AGUARDANDO_CHAMADA",
        expectedVersion: 3,
        reason: "Cliente liberou a carga",
        nowIso: NOW
      })
    ).rejects.toMatchObject({ status: 409 });

    await expect(
      transitionInternalCheckin({
        actor: OPERATOR,
        checkinId: "checkin-1",
        toStatus: "AGUARDANDO_CHAMADA",
        expectedVersion: 3,
        reason: "Tentativa direta",
        nowIso: NOW
      })
    ).rejects.toMatchObject({ status: 403 });

    seedCheckin({ clientId: "client-1", clientNameSnapshot: "Cliente Alfa" });
    await expect(
      transitionInternalCheckin({
        actor: MANAGER,
        checkinId: "checkin-1",
        toStatus: "AGUARDANDO_CHAMADA",
        expectedVersion: 3,
        reason: "Cliente liberou a carga",
        nowIso: NOW
      })
    ).resolves.toMatchObject({ status: "AGUARDANDO_CHAMADA", version: 4 });
  });

  it("rejects stale versions without writing a revision", async () => {
    seedCheckin();
    inMemoryAdminDb.seed("clients", "client-1", { name: "Cliente Alfa", active: true });

    await expect(
      assignInternalCheckinClient({
        actor: MANAGER,
        checkinId: "checkin-1",
        clientId: "client-1",
        expectedVersion: 2,
        reason: "Identificação confirmada",
        nowIso: NOW
      })
    ).rejects.toMatchObject({ status: 409 });
    expect(inMemoryAdminDb.entries("checkins/checkin-1/revisions")).toHaveLength(0);
  });

  it("blocks internal mutations while public Excel confirmation needs reconciliation", async () => {
    seedCheckin({ status: "PRE_CADASTRO", syncState: "FALHA_RETRY" });
    inMemoryAdminDb.seed("clients", "client-1", { name: "Cliente Alfa", active: true });

    await expect(
      assignInternalCheckinClient({
        actor: MANAGER,
        checkinId: "checkin-1",
        clientId: "client-1",
        expectedVersion: 3,
        reason: "Identificação confirmada",
        nowIso: NOW
      })
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      correctInternalCheckin({
        actor: MANAGER,
        checkinId: "checkin-1",
        patch: { carrierName: "Transportadora Corrigida" },
        expectedVersion: 3,
        reason: "Transportadora confirmou o nome",
        nowIso: NOW
      })
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      cancelInternalCheckin({
        actor: MANAGER,
        checkinId: "checkin-1",
        expectedVersion: 3,
        reason: "Solicitação de cancelamento",
        nowIso: NOW
      })
    ).rejects.toMatchObject({ status: 409 });
    expect(inMemoryAdminDb.entries("checkins/checkin-1/revisions")).toEqual([]);
  });

  it("cancels only with a manager reason and releases active uniqueness locks", async () => {
    seedCheckin();
    inMemoryAdminDb.seed("_checkinUniqueLocks", "cnh_v1_cnh-index", {
      checkinId: "checkin-1"
    });
    inMemoryAdminDb.seed("_checkinUniqueLocks", "plate_v1_plate-index", {
      checkinId: "checkin-1"
    });

    await expect(
      cancelInternalCheckin({
        actor: MANAGER,
        checkinId: "checkin-1",
        expectedVersion: 3,
        reason: "  ",
        nowIso: NOW
      })
    ).rejects.toMatchObject({ status: 400 });

    const result = await cancelInternalCheckin({
      actor: MANAGER,
      checkinId: "checkin-1",
      expectedVersion: 3,
      reason: "Carga cancelada pela transportadora",
      nowIso: NOW
    });

    expect(result).toMatchObject({
      status: "CANCELADO",
      cancellationReason: "Carga cancelada pela transportadora",
      version: 4
    });
    expect(inMemoryAdminDb.read("_checkinUniqueLocks", "cnh_v1_cnh-index")).toBeUndefined();
    expect(inMemoryAdminDb.read("_checkinUniqueLocks", "plate_v1_plate-index")).toBeUndefined();
  });

  it("corrects a pre-registration with validation, optimistic version and no PII in its revision", async () => {
    seedCheckin({ status: "PRE_CADASTRO", syncState: null });

    const result = await correctInternalCheckin({
      actor: MANAGER,
      checkinId: "checkin-1",
      patch: { carrierName: "Transportadora Corrigida" },
      expectedVersion: 3,
      reason: "Transportadora confirmou o nome correto",
      nowIso: NOW
    });

    expect(result).toMatchObject({ carrierName: "Transportadora Corrigida", version: 4 });
    expect(inMemoryAdminDb.entries("checkins/checkin-1/revisions")[0]?.[1]).toMatchObject({
      action: "CHECKIN_CORRECTED",
      changedFields: ["carrierName"],
      previousVersion: 3,
      newVersion: 4
    });
    expect(JSON.stringify(inMemoryAdminDb.entries("checkins/checkin-1/revisions"))).not.toContain(
      "Transportadora Corrigida"
    );
  });

  it("requires official Excel confirmation before consolidating a post-check-in correction", async () => {
    seedCheckin();

    await expect(
      correctInternalCheckin({
        actor: MANAGER,
        checkinId: "checkin-1",
        patch: { carrierName: "Transportadora Corrigida" },
        expectedVersion: 3,
        reason: "Transportadora confirmou o nome correto",
        nowIso: NOW
      })
    ).rejects.toMatchObject({ status: 409 });

    await expect(
      correctInternalCheckin({
        actor: MANAGER,
        checkinId: "checkin-1",
        patch: { carrierName: "Transportadora Corrigida" },
        expectedVersion: 3,
        reason: "Transportadora confirmou o nome correto",
        nowIso: NOW
      }, {
        confirmedAtIso: "2026-08-10T18:00:01.000Z"
      })
    ).resolves.toMatchObject({
      carrierName: "Transportadora Corrigida",
      syncState: "CONFIRMADO",
      version: 4
    });
  });

  it("records a highlighted GPS bypass only after the official row is confirmed", async () => {
    seedCheckin({ status: "PRE_CADASTRO", syncState: null, geofence: null });

    await expect(
      overrideInternalCheckinLocation({
        actor: MANAGER,
        checkinId: "checkin-1",
        expectedVersion: 3,
        justification: "GPS do aparelho indisponível",
        nowIso: NOW
      })
    ).rejects.toMatchObject({ status: 409 });

    const result = await overrideInternalCheckinLocation({
      actor: MANAGER,
      checkinId: "checkin-1",
      expectedVersion: 3,
      justification: "GPS do aparelho indisponível; presença verificada pela supervisão",
      nowIso: NOW
    }, {
      confirmedAtIso: "2026-08-10T18:00:02.000Z"
    });

    expect(result).toMatchObject({
      status: "AGUARDANDO_LIBERACAO",
      syncState: "CONFIRMADO",
      version: 4,
      locationOverride: {
        applied: true,
        justification: "GPS do aparelho indisponível; presença verificada pela supervisão"
      }
    });
    expect(inMemoryAdminDb.entries("checkins/checkin-1/revisions")[0]?.[1]).toMatchObject({
      action: "GPS_OVERRIDE_CONFIRMED",
      highlight: "GPS_BYPASS"
    });
  });

  it("requires deletion of the owning productive event before undoing EM_DESCARGA", async () => {
    seedCheckin({
      status: "EM_DESCARGA",
      activeProductiveEventId: "event-1",
      clientId: "client-1",
      clientNameSnapshot: "Cliente Alfa"
    });

    await expect(
      transitionInternalCheckin({
        actor: OPERATOR,
        checkinId: "checkin-1",
        toStatus: "CHAMADO",
        expectedVersion: 3,
        reason: "Seleção incorreta",
        nowIso: NOW
      })
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      transitionInternalCheckin({
        actor: MANAGER,
        checkinId: "checkin-1",
        toStatus: "CHAMADO",
        expectedVersion: 3,
        reason: "Seleção incorreta no lançamento produtivo",
        nowIso: NOW
      })
    ).rejects.toMatchObject({
      status: 409,
      code: "CHECKIN_EVENT_MISMATCH"
    });
  });

  it("keeps a manager-only recovery path for legacy unloading rows without an event link", async () => {
    seedCheckin({
      status: "EM_DESCARGA",
      clientId: "client-1",
      clientNameSnapshot: "Cliente Alfa"
    });

    await expect(
      transitionInternalCheckin({
        actor: MANAGER,
        checkinId: "checkin-1",
        toStatus: "CHAMADO",
        expectedVersion: 3,
        reason: "Registro legado sem vínculo produtivo",
        nowIso: NOW
      })
    ).resolves.toMatchObject({ status: "CHAMADO", version: 4 });
  });

  it("clears the active event ownership when a manager concludes unloading", async () => {
    seedCheckin({
      status: "EM_DESCARGA",
      activeProductiveEventId: "event-1",
      clientId: "client-1",
      clientNameSnapshot: "Cliente Alfa"
    });

    await expect(
      transitionInternalCheckin({
        actor: MANAGER,
        checkinId: "checkin-1",
        toStatus: "CONCLUIDO",
        expectedVersion: 3,
        reason: "Operação finalizada",
        nowIso: NOW
      })
    ).resolves.toMatchObject({
      status: "CONCLUIDO",
      activeProductiveEventId: null,
      version: 4
    });
    expect(inMemoryAdminDb.read("checkins", "checkin-1")).toMatchObject({
      status: "CONCLUIDO",
      activeProductiveEventId: null,
      version: 4
    });
  });
});
