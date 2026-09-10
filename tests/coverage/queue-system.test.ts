import { beforeEach, describe, it, expect, vi } from "vitest";
import { inMemoryAdminDb as db } from "./in-memory-firestore";
vi.mock("@/lib/firebase/admin", () => ({ adminDb: db }));
vi.mock("@/lib/server/request-protection", () => ({
  protectApiRequest: vi.fn(),
}));
import {
  createOrRecoverPreRegistration,
  confirmCheckin,
} from "@/lib/server/checkins/service";
import {
  listQueuePage,
  getQueueVisit,
  mutateQueue,
  queueCommandSchema,
} from "@/lib/server/checkins/queue-service";
import { ensureQueueApiAccess } from "@/lib/server/auth";
import { queueCsv } from "@/lib/domain/queue";
import type { UserDoc } from "@/types/domain";
import {
  createEvent,
  softDeleteEvent,
  restoreEvent,
  previewEventRestore,
} from "@/lib/server/events";
import { previewEventGap, prepareDeletionGap } from "@/lib/server/gaps";
const now = "2026-09-10T12:00:00.000Z";
const id = "11111111-1111-4111-8111-111111111111";
const form = {
  driverName: "Motorista de teste",
  driverLicense: "05555930435",
  driverPhone: "44999197442",
  plate: "ABC1D23",
  carrierName: "Transportadora Teste",
  vehicleType: "Bitrem",
  product: "Glicerina",
  originPlant: "Usina Teste",
  originInvoiceNumbers: "DEMO-01",
  remittanceInvoiceNumber: "DEMO-02",
  whatsappNoticeAccepted: true,
  queueLocationAccepted: true,
};
const profile = (role: UserDoc["role"], clientId: string | null = null) =>
  ({
    role,
    clientId,
    active: true,
    approved: true,
    name: role,
    email: `${role}@example.test`,
  }) as UserDoc;
const analyst = { uid: "analyst", profile: profile("ANALYST") };
const customer = { uid: "customer", profile: profile("CUSTOMER", "allog") };
function seed(overrides: Record<string, unknown> = {}) {
  db.seed("checkins", id, {
    ...form,
    id,
    plate: "ABC-1D23",
    publicCode: "LT-23456789",
    source: "DRIVER",
    status: "AGUARDANDO_LIBERACAO",
    version: 2,
    syncState: "CONFIRMADO",
    clientId: "allog",
    clientNameSnapshot: "ALLOG",
    createdAtIso: now,
    updatedAtIso: now,
    confirmedAtIso: now,
    driverLicenseIndex: "v1:lic",
    driverPhoneIndex: "v1:phone",
    plateIndex: "v1:plate",
    geofence: { allowed: true },
    location: {
      latitude: -23.9,
      longitude: -46.3,
      accuracyMeters: 20,
      capturedAtIso: now,
    },
    booking: "BK",
    sample: "OK",
    observation: "",
    issues: [{ id: "doc", description: "Documento pendente", resolved: false }],
    ...overrides,
  });
}
const shared = { booking: "BK-NOVO", sample: "OK", observation: "Atualização" };
beforeEach(() => {
  db.reset();
  vi.unstubAllEnvs();
  vi.stubEnv("CHECKIN_SYSTEM_RECORD_ENABLED", "true");
  vi.stubEnv("CHECKIN_INTEGRATION_MODE", "observe");
  vi.stubEnv("CHECKIN_INDEX_HMAC_SECRET", "x".repeat(32));
  db.seed("clients", "allog", {
    name: "ALLOG",
    active: true,
    portalEnabled: true,
    usesSample: true,
  });
  db.seed("clients", "other", {
    name: "Outro",
    active: true,
    portalEnabled: false,
  });
  db.seed("users", analyst.uid, { ...analyst.profile });
  db.seed("users", customer.uid, { ...customer.profile });
});
describe("system is the official check-in record", () => {
  it("confirms without Excel, retains private GPS, and repeated requests do not duplicate", async () => {
    const registered = await createOrRecoverPreRegistration(
      { rawForm: form, source: "DRIVER", nowIso: now },
      { generateId: () => id, generatePublicCode: () => "LT-23456789" },
    );
    const input = {
      publicCode: registered.publicCode,
      driverLicense: form.driverLicense,
      driverPhone: form.driverPhone,
      plate: form.plate,
      location: {
        latitude: -23.96,
        longitude: -46.33,
        accuracyMeters: 20,
        capturedAtIso: now,
      },
      nowIso: now,
      expectedVersion: registered.version,
    };
    const deps = {
      allowedArea: { latitude: -23.96, longitude: -46.33, radiusMeters: 20000 },
    };
    await expect(confirmCheckin(input, deps)).resolves.toMatchObject({
      status: "AGUARDANDO_LIBERACAO",
      version: 2,
    });
    await expect(confirmCheckin(input, deps)).resolves.toMatchObject({
      version: 2,
    });
    expect(db.read("checkins", id)).toMatchObject({ location: input.location });
    expect(db.entries("_checkinSyncCommands")).toHaveLength(0);
    db.seed("checkins", id, { ...db.read("checkins", id)!, status: "CHAMADO" });
    await expect(confirmCheckin(input, deps)).resolves.toMatchObject({
      status: "CHAMADO",
      version: 2,
    });
  });
  it("blocks out-of-region confirmation without changing the visit", async () => {
    const r = await createOrRecoverPreRegistration(
      { rawForm: form, source: "DRIVER", nowIso: now },
      { generateId: () => id, generatePublicCode: () => "LT-23456789" },
    );
    await expect(
      confirmCheckin(
        {
          publicCode: r.publicCode,
          driverLicense: form.driverLicense,
          driverPhone: form.driverPhone,
          plate: form.plate,
          location: {
            latitude: 0,
            longitude: 0,
            accuracyMeters: 10,
            capturedAtIso: now,
          },
          nowIso: now,
          expectedVersion: 1,
        },
        {
          allowedArea: {
            latitude: -23.96,
            longitude: -46.33,
            radiusMeters: 20000,
          },
        },
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(db.read("checkins", id)?.status).toBe("PRE_CADASTRO");
  });
});
describe("customer boundaries and audited collaboration", () => {
  it("filters at the database and omits all internal fields, including nested history", async () => {
    seed();
    db.seed("checkins", "other-visit", {
      ...db.read("checkins", id)!,
      clientId: "other",
      driverName: "OTHER_PRIVATE",
    });
    const page = await listQueuePage(customer);
    expect(page.items).toHaveLength(1);
    expect(JSON.stringify(page)).not.toMatch(
      /driverLicense|driverPhone|location|issues|geofence|OTHER_PRIVATE/,
    );
    await expect(getQueueVisit(customer, "other-visit")).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      mutateQueue(customer, "other-visit", {
        expectedVersion: 2,
        command: { kind: "SHARED", shared },
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("rejects extra fields and operational commands from customers", async () => {
    seed();
    expect(() =>
      queueCommandSchema.parse({
        expectedVersion: 2,
        command: { kind: "SHARED", shared: { ...shared, clientId: "other" } },
      }),
    ).toThrow();
    await expect(
      mutateQueue(customer, id, {
        expectedVersion: 2,
        command: { kind: "TRANSITION", toStatus: "CHAMADO" },
      }),
    ).rejects.toMatchObject({ status: 403 });
    for (const path of [
      "/api/events",
      "/api/clients",
      "/api/checkins",
      "/api/reports/export",
      "/api/users",
    ])
      expect(() => ensureQueueApiAccess(customer.profile, path)).toThrow();
  });
  it("Line and client both edit, with conflicts instead of lost updates", async () => {
    seed();
    await mutateQueue(customer, id, {
      expectedVersion: 2,
      command: { kind: "SHARED", shared },
    });
    await expect(
      mutateQueue(analyst, id, {
        expectedVersion: 2,
        command: { kind: "SHARED", shared: { ...shared, booking: "STALE" } },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(db.read("checkins", id)?.booking).toBe("BK-NOVO");
    expect(db.entries(`checkins/${id}/revisions`)).toHaveLength(1);
    expect(db.entries(`checkins/${id}/revisions`)[0][1]).toMatchObject({
      actorRole: "CUSTOMER",
      before: { booking: "BK" },
      after: { booking: "BK-NOVO" },
    });
  });
  it.each(["CONCLUIDO", "CANCELADO"])(
    "customer cannot edit %s but Line can correct shared fields",
    async (status) => {
      seed({ status });
      await expect(
        mutateQueue(customer, id, {
          expectedVersion: 2,
          command: { kind: "SHARED", shared },
        }),
      ).rejects.toMatchObject({ status: 403 });
      await mutateQueue(analyst, id, {
        expectedVersion: 2,
        command: { kind: "SHARED", shared },
      });
      expect(db.read("checkins", id)?.booking).toBe("BK-NOVO");
    },
  );
  it("customer edits remain available during unloading", async () => {
    seed({ status: "EM_DESCARGA" });
    await mutateQueue(customer, id, {
      expectedVersion: 2,
      command: { kind: "SHARED", shared },
    });
    expect(db.read("checkins", id)?.status).toBe("EM_DESCARGA");
  });
  it("revoking client participation blocks edits while Line retains access", async () => {
    seed();
    db.seed("clients", "allog", {
      name: "ALLOG",
      active: true,
      portalEnabled: false,
    });
    await expect(
      mutateQueue(customer, id, {
        expectedVersion: 2,
        command: { kind: "SHARED", shared },
      }),
    ).rejects.toMatchObject({ status: 403 });
    await mutateQueue(analyst, id, {
      expectedVersion: 2,
      command: { kind: "SHARED", shared },
    });
  });
  it("no sample approval or classification advances the operational status", async () => {
    seed();
    await mutateQueue(analyst, id, {
      expectedVersion: 2,
      command: {
        kind: "CLASSIFY",
        clientId: "allog",
        shared,
        issues: [
          { id: "doc", description: "Documento pendente", resolved: false },
        ],
      },
    });
    expect(db.read("checkins", id)?.status).toBe("AGUARDANDO_LIBERACAO");
    await expect(
      mutateQueue(analyst, id, {
        expectedVersion: 3,
        command: { kind: "TRANSITION", toStatus: "AGUARDANDO_CHAMADA" },
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("reassignment removes the previous customer's shared information", async () => {
    seed();
    await mutateQueue(analyst, id, {
      expectedVersion: 2,
      command: { kind: "CLASSIFY", clientId: "other", shared, issues: [] },
    });
    expect(db.read("checkins", id)).toMatchObject({
      clientId: "other",
      booking: "",
      sample: "",
      observation: "",
    });
    await expect(getQueueVisit(customer, id)).rejects.toMatchObject({
      status: 404,
    });
  });
  it("CSV is bounded to the supplied authorized DTO and neutralizes formulas", async () => {
    seed({ booking: "=1+1", observation: "linha\ncom ; separador" });
    const page = await listQueuePage(customer);
    const csv = queueCsv(page.items);
    expect(csv).toContain("'=1+1");
    expect(csv).not.toMatch(/05555930435|latitude|Documento pendente/);
  });
});
function eventInput(expectedContainerStateVersion = 0) {
  return {
    pump: "BOMBA_1",
    shiftDate: "2026-09-10",
    shiftType: "MANHA",
    startTime: "06:00",
    endTime: "06:10",
    category: "PRODUTIVO",
    clientId: "allog",
    plate: "ABC1D23",
    container: "ABCU1234560",
    containerStatus: "FULL",
    containerReason: null,
    startsNewContainerCycle: false,
    blendConfirmed: false,
    loadSourceType: "TRUCK",
    expectedContainerStateVersion,
    notes: null,
    checkInId: id,
    expectedCheckinVersion: 2,
  };
}
const operator = { uid: "operator", email: "operator@example.test" };
describe("productive event owns the discharge transition", () => {
  it("failure leaves the visit called and successful event deletion/restore maintain linkage", async () => {
    seed({ status: "CHAMADO", issues: [] });
    const invalid = eventInput(99);
    const gap = await previewEventGap(invalid);
    await expect(
      createEvent({ ...invalid, gapVersion: gap.gapVersion }, operator),
    ).rejects.toMatchObject({ status: 409 });
    expect(db.read("checkins", id)?.status).toBe("CHAMADO");
    expect(db.entries("events")).toHaveLength(0);
    const created = await createEvent(
      { ...eventInput(), gapVersion: gap.gapVersion },
      operator,
    );
    expect(db.read("checkins", id)).toMatchObject({
      status: "EM_DESCARGA",
      activeProductiveEventId: created.id,
    });
    const deletion = await prepareDeletionGap(created.id);
    await softDeleteEvent(created.id, "Seleção incorreta", operator, {
      gapVersion: deletion.preview.gapVersion,
    });
    expect(db.read("checkins", id)).toMatchObject({
      status: "CHAMADO",
      activeProductiveEventId: null,
    });
    const restore = await previewEventRestore(created.id);
    await restoreEvent(created.id, operator, {
      gapVersion: restore.gapVersion,
      expectedContainerStateVersion: restore.expectedContainerStateVersion,
    });
    expect(db.read("checkins", id)).toMatchObject({
      status: "EM_DESCARGA",
      activeProductiveEventId: created.id,
    });
  });
  it("rejects a stale selection and a changed client", async () => {
    seed({ status: "CHAMADO", issues: [], version: 3 });
    const input = eventInput();
    const gap = await previewEventGap(input);
    await expect(
      createEvent({ ...input, gapVersion: gap.gapVersion }, operator),
    ).rejects.toMatchObject({ status: 409 });
    expect(db.entries("events")).toHaveLength(0);
  });
});

describe("corrections preserve identity and authorization", () => {
  it("corrects received data without Excel, records a revision and preserves the status", async () => {
    seed();
    await mutateQueue(analyst, id, {
      expectedVersion: 2,
      command: {
        kind: "CORRECT",
        patch: { driverName: "Motorista corrigido" },
        reason: "Conferência do documento",
      },
    });
    expect(db.read("checkins", id)).toMatchObject({
      driverName: "Motorista corrigido",
      version: 3,
      status: "AGUARDANDO_LIBERACAO",
    });
    expect(db.entries(`checkins/${id}/revisions`)[0][1]).toMatchObject({
      reason: "Conferência do documento",
      changedFields: ["driverName"],
      actorUid: analyst.uid,
    });
  });
  it("rekeys identity locks atomically and rejects another active visit's plate", async () => {
    const r = await createOrRecoverPreRegistration(
      { rawForm: form, source: "DRIVER", nowIso: now },
      { generateId: () => id, generatePublicCode: () => "LT-23456789" },
    );
    await confirmCheckin(
      {
        publicCode: r.publicCode,
        driverLicense: form.driverLicense,
        driverPhone: form.driverPhone,
        plate: form.plate,
        location: {
          latitude: 0,
          longitude: 0,
          accuracyMeters: 10,
          capturedAtIso: now,
        },
        nowIso: now,
        expectedVersion: 1,
      },
      { allowedArea: { latitude: 0, longitude: 0, radiusMeters: 500 } },
    );
    await mutateQueue(analyst, id, {
      expectedVersion: 2,
      command: {
        kind: "CORRECT",
        patch: { plate: "XYZ9A99" },
        reason: "Placa conferida",
      },
    });
    const current = db.read("checkins", id)!;
    expect(current.plate).toBe("XYZ-9A99");
    expect(db.entries("_checkinUniqueLocks")).toHaveLength(2);
    await createOrRecoverPreRegistration(
      {
        rawForm: {
          ...form,
          driverLicense: "10000000091",
          driverPhone: "11987654321",
        },
        source: "DRIVER",
        nowIso: now,
      },
      {
        generateId: () => "22222222-2222-4222-8222-222222222222",
        generatePublicCode: () => "LT-ABCDEFGH",
      },
    );
    await expect(
      mutateQueue(analyst, id, {
        expectedVersion: 3,
        command: {
          kind: "CORRECT",
          patch: { plate: form.plate },
          reason: "Tentativa duplicada",
        },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(db.read("checkins", id)?.plate).toBe("XYZ-9A99");
  });
  it("rejects stale corrections, empty changes, and revoked analysts", async () => {
    seed();
    const body = {
      expectedVersion: 2,
      command: {
        kind: "CORRECT",
        patch: { driverName: "Nome novo" },
        reason: "Conferido",
      },
    };
    await expect(
      mutateQueue(analyst, id, { ...body, expectedVersion: 1 }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      mutateQueue(analyst, id, {
        ...body,
        command: { ...body.command, patch: { driverName: form.driverName } },
      }),
    ).rejects.toMatchObject({ status: 400 });
    db.seed("users", analyst.uid, { ...analyst.profile, active: false });
    await expect(mutateQueue(analyst, id, body)).rejects.toMatchObject({
      status: 403,
    });
    expect(db.read("checkins", id)?.version).toBe(2);
  });
  it("does not change the identity of an already linked visit", async () => {
    seed({ status: "EM_DESCARGA", activeProductiveEventId: "event" });
    await expect(
      mutateQueue(analyst, id, {
        expectedVersion: 2,
        command: {
          kind: "CORRECT",
          patch: { plate: "XYZ9A99" },
          reason: "Conferido",
        },
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("pre-registration does not enter the analyst queue before confirmation", async () => {
    seed({ status: "PRE_CADASTRO", confirmedAtIso: null });
    expect((await listQueuePage(analyst)).items).toEqual([]);
    await expect(getQueueVisit(analyst, id)).rejects.toMatchObject({
      status: 404,
    });
  });
  it("release and call are independent writes and closure releases uniqueness locks", async () => {
    seed({ issues: [] });
    await mutateQueue(analyst, id, {
      expectedVersion: 2,
      command: { kind: "TRANSITION", toStatus: "AGUARDANDO_CHAMADA" },
    });
    expect(db.read("checkins", id)?.status).toBe("AGUARDANDO_CHAMADA");
    await mutateQueue(analyst, id, {
      expectedVersion: 3,
      command: { kind: "TRANSITION", toStatus: "CHAMADO" },
    });
    expect(db.read("checkins", id)?.status).toBe("CHAMADO");
    db.seed("checkins", id, {
      ...db.read("checkins", id)!,
      status: "EM_DESCARGA",
    });
    db.seed("_checkinUniqueLocks", "cnh_v1_lic", { checkinId: id });
    db.seed("_checkinUniqueLocks", "plate_v1_plate", { checkinId: id });
    await mutateQueue(analyst, id, {
      expectedVersion: 4,
      command: { kind: "TRANSITION", toStatus: "CONCLUIDO" },
    });
    expect(db.read("checkins", id)?.status).toBe("CONCLUIDO");
    expect(db.entries("_checkinUniqueLocks")).toHaveLength(0);
  });
});

it("paginates equal-timestamp visits without missing or repeating a row", async () => {
  seed();
  const data = db.read("checkins", id)!;
  for (let i = 0; i < 105; i++)
    db.seed("checkins", `page-${String(i).padStart(3, "0")}`, {
      ...data,
      id: `page-${i}`,
    });
  const first = await listQueuePage(customer);
  expect(first.items).toHaveLength(100);
  expect(first.nextCursor).toBeTruthy();
  const second = await listQueuePage(customer, first.nextCursor!);
  expect(second.items).toHaveLength(6);
  expect(second.nextCursor).toBeNull();
  expect(new Set([...first.items, ...second.items].map((v) => v.id)).size).toBe(
    106,
  );
  await expect(listQueuePage(customer, "missing")).rejects.toMatchObject({
    status: 400,
  });
});
