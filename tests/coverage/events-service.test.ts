import { beforeEach, describe, expect, it, vi } from "vitest";
import { inMemoryAdminDb } from "./in-memory-firestore";

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: inMemoryAdminDb
}));

import {
  createEvent,
  listEvents,
  previewEventRestore,
  restoreEvent,
  softDeleteEvent,
  updateEvent
} from "@/lib/server/events";
import { prepareDeletionGap } from "@/lib/server/gaps";

const actor = {
  uid: "operator-1",
  email: "operator@example.com",
  role: "OPERATOR" as const
};
const managerActor = {
  uid: "supervisor-1",
  email: "supervisor@example.com",
  role: "SUPERVISOR" as const
};
const checkInId = "11111111-1111-4111-8111-111111111111";

function eventInput(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    pump: "BOMBA_1",
    shiftDate: "2026-07-27",
    shiftType: "MANHA",
    startTime: "06:00",
    endTime: "06:10",
    category: "OUTROS",
    clientId: null,
    plate: null,
    container: null,
    containerStatus: null,
    containerReason: null,
    startsNewContainerCycle: false,
    blendConfirmed: false,
    expectedContainerStateVersion: null,
    notes: "Preparação operacional",
    ...overrides
  };
}

describe("public event command service", () => {
  beforeEach(() => {
    delete process.env.CHECKIN_INTEGRATION_MODE;
    process.env.CHECKIN_INTEGRATION_KEY_ID = "checkin-v1";
    process.env.CHECKIN_INTEGRATION_HMAC_SECRET = "a".repeat(32);
    process.env.CHECKIN_INDEX_HMAC_SECRET = "b".repeat(32);
    process.env.CHECKIN_GEOFENCE_CENTER_LAT = "-23.9608";
    process.env.CHECKIN_GEOFENCE_CENTER_LNG = "-46.3336";
    process.env.CHECKIN_POWER_AUTOMATE_ADD_URL = "https://example.test/checkins/add";
    process.env.CHECKIN_POWER_AUTOMATE_UPDATE_URL = "https://example.test/checkins/update";
    process.env.CHECKIN_ENFORCE_ROLLOUT_APPROVED = "true";
    inMemoryAdminDb.reset();
    inMemoryAdminDb.seed("settings", "operations", {
      idleToleranceMinutes: 10
    });
  });

  it("fails closed before enforcing check-ins without explicit rollout approval", async () => {
    process.env.CHECKIN_INTEGRATION_MODE = "enforce";
    delete process.env.CHECKIN_ENFORCE_ROLLOUT_APPROVED;

    await expect(
      createEvent(
        eventInput({
          category: "PRODUTIVO",
          clientId: "client-1",
          plate: "ABC1D23",
          container: "ABCU1234560",
          containerStatus: "FULL",
          expectedContainerStateVersion: 0
        }),
        actor
      )
    ).rejects.toMatchObject({ status: 500 });
    expect(inMemoryAdminDb.entries("events")).toEqual([]);
  });

  it("links a called check-in atomically when creating a productive event in observe mode", async () => {
    process.env.CHECKIN_INTEGRATION_MODE = "observe";
    inMemoryAdminDb.seed("clients", "client-1", {
      active: true,
      name: "Cliente 1"
    });
    inMemoryAdminDb.seed("checkins", checkInId, {
      id: checkInId,
      status: "CHAMADO",
      plate: "ABC1D23",
      version: 7,
      updatedAtIso: "2026-07-27T08:00:00.000Z"
    });

    const input = eventInput({
      category: "PRODUTIVO",
      clientId: "client-1",
      plate: "ZZZ9999",
      container: "ABCU1234560",
      containerStatus: "FULL",
      expectedContainerStateVersion: 0,
      checkInId
    });
    const { previewEventGap } = await import("@/lib/server/gaps");
    const preview = await previewEventGap(input);

    const created = await createEvent(
      { ...input, gapVersion: preview.gapVersion },
      { ...actor, role: "OPERATOR" }
    );

    expect(created).toMatchObject({
      checkInId,
      plate: "ABC-1D23"
    });
    expect(inMemoryAdminDb.read("checkins", checkInId)).toMatchObject({
      status: "EM_DESCARGA",
      activeProductiveEventId: created.id,
      version: 8
    });
    expect(
      inMemoryAdminDb.entries(`checkins/${checkInId}/revisions`)
    ).toEqual([
      expect.arrayContaining([
        expect.any(String),
        expect.objectContaining({
          action: "PRODUCTIVE_EVENT_LINKED",
          eventId: created.id,
          reason: "Check-in selecionado no lançamento produtivo.",
          changedFields: ["status", "activeProductiveEventId"],
          previousStatus: "CHAMADO",
          newStatus: "EM_DESCARGA",
          previousVersion: 7,
          newVersion: 8
        })
      ])
    ]);
  });

  it("rejects a check-in link for non-productive events", async () => {
    process.env.CHECKIN_INTEGRATION_MODE = "observe";

    await expect(
      createEvent(
        eventInput({ checkInId }),
        { ...actor, role: "OPERATOR" }
      )
    ).rejects.toMatchObject({ status: 400 });

    expect(inMemoryAdminDb.entries("events")).toHaveLength(0);
  });

  it("does not let the display profile move a called check-in into unloading", async () => {
    process.env.CHECKIN_INTEGRATION_MODE = "observe";

    await expect(
      createEvent(
        eventInput({ category: "PRODUTIVO", checkInId }),
        { ...actor, role: "DISPLAY" }
      )
    ).rejects.toMatchObject({ status: 403 });

    expect(inMemoryAdminDb.entries("events")).toHaveLength(0);
  });

  it("keeps legacy manual-plate behavior while integration mode is off", async () => {
    process.env.CHECKIN_INTEGRATION_MODE = "off";
    inMemoryAdminDb.seed("clients", "client-1", {
      active: true,
      name: "Cliente 1"
    });
    const input = eventInput({
      category: "PRODUTIVO",
      clientId: "client-1",
      plate: "ZZZ9999",
      container: "ABCU1234560",
      containerStatus: "FULL",
      expectedContainerStateVersion: 0,
      checkInId
    });
    const { previewEventGap } = await import("@/lib/server/gaps");
    const preview = await previewEventGap(input);

    const created = await createEvent(
      { ...input, gapVersion: preview.gapVersion },
      { ...actor, role: "OPERATOR" }
    );

    expect(created).toMatchObject({ plate: "ZZZ-9999" });
    expect(created).not.toHaveProperty("checkInId");
  });

  it("ignores additive linkage fields on non-productive events while mode is off", async () => {
    process.env.CHECKIN_INTEGRATION_MODE = "off";

    const created = await createEvent(
      eventInput({ checkInId }),
      { ...actor, role: "OPERATOR" }
    );

    expect(created).toMatchObject({ category: "OUTROS" });
    expect(created).not.toHaveProperty("checkInId");
  });

  it("requires a called check-in in enforce mode and permits only an audited admin fallback", async () => {
    process.env.CHECKIN_INTEGRATION_MODE = "enforce";
    inMemoryAdminDb.seed("clients", "client-1", {
      active: true,
      name: "Cliente 1"
    });
    const input = eventInput({
      category: "PRODUTIVO",
      clientId: "client-1",
      plate: "ABC1D23",
      container: "ABCU1234560",
      containerStatus: "FULL",
      expectedContainerStateVersion: 0
    });

    await expect(
      createEvent(input, { ...actor, role: "OPERATOR" })
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      createEvent(input, { ...actor, role: "SUPERVISOR" })
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      createEvent(input, { ...actor, role: "ADMIN" })
    ).rejects.toMatchObject({ status: 400 });

    const { previewEventGap } = await import("@/lib/server/gaps");
    const preview = await previewEventGap(input);
    const created = await createEvent(
      {
        ...input,
        manualPlateReason: "Check-in indisponível durante contingência",
        gapVersion: preview.gapVersion
      },
      { ...actor, role: "ADMIN" }
    );

    expect(created).toMatchObject({
      checkInId: null,
      manualPlateReason: "Check-in indisponível durante contingência",
      plate: "ABC-1D23"
    });
  });

  it("lets a supervisor select a called check-in in enforce mode", async () => {
    process.env.CHECKIN_INTEGRATION_MODE = "enforce";
    inMemoryAdminDb.seed("clients", "client-1", {
      active: true,
      name: "Cliente 1"
    });
    inMemoryAdminDb.seed("checkins", checkInId, {
      id: checkInId,
      status: "CHAMADO",
      plate: "ABC1D23",
      version: 5,
      updatedAtIso: "2026-07-27T08:00:00.000Z"
    });
    const input = eventInput({
      category: "PRODUTIVO",
      clientId: "client-1",
      plate: "ZZZ9999",
      container: "ABCU1234560",
      containerStatus: "FULL",
      expectedContainerStateVersion: 0,
      checkInId
    });
    const { previewEventGap } = await import("@/lib/server/gaps");
    const preview = await previewEventGap(input);

    const created = await createEvent(
      { ...input, gapVersion: preview.gapVersion },
      { ...actor, role: "SUPERVISOR" }
    );

    expect(created).toMatchObject({ checkInId, plate: "ABC-1D23" });
    expect(inMemoryAdminDb.read("checkins", checkInId)).toMatchObject({
      status: "EM_DESCARGA",
      version: 6
    });
  });

  it("rolls the check-in transition back when the productive event transaction fails", async () => {
    process.env.CHECKIN_INTEGRATION_MODE = "observe";
    inMemoryAdminDb.seed("clients", "client-1", {
      active: true,
      name: "Cliente 1"
    });
    inMemoryAdminDb.seed("checkins", checkInId, {
      id: checkInId,
      status: "CHAMADO",
      plate: "ABC1D23",
      version: 4,
      updatedAtIso: "2026-07-27T08:00:00.000Z"
    });
    const input = eventInput({
      category: "PRODUTIVO",
      clientId: "client-1",
      plate: "ABC1D23",
      container: "ABCU1234560",
      containerStatus: "FULL",
      expectedContainerStateVersion: 99,
      checkInId
    });
    const { previewEventGap } = await import("@/lib/server/gaps");
    const preview = await previewEventGap(input);

    await expect(
      createEvent(
        { ...input, gapVersion: preview.gapVersion },
        { ...actor, role: "OPERATOR" }
      )
    ).rejects.toMatchObject({ status: 409 });

    expect(inMemoryAdminDb.read("checkins", checkInId)).toMatchObject({
      status: "CHAMADO",
      version: 4
    });
    expect(inMemoryAdminDb.entries("events")).toHaveLength(0);
    expect(
      inMemoryAdminDb.entries(`checkins/${checkInId}/revisions`)
    ).toHaveLength(0);
  });

  it("rejects a second productive selection after the check-in leaves CHAMADO", async () => {
    process.env.CHECKIN_INTEGRATION_MODE = "observe";
    inMemoryAdminDb.seed("clients", "client-1", {
      active: true,
      name: "Cliente 1"
    });
    inMemoryAdminDb.seed("checkins", checkInId, {
      id: checkInId,
      status: "CHAMADO",
      plate: "ABC1D23",
      version: 2,
      updatedAtIso: "2026-07-27T08:00:00.000Z"
    });
    const firstInput = eventInput({
      category: "PRODUTIVO",
      clientId: "client-1",
      plate: "ABC1D23",
      container: "ABCU1234560",
      containerStatus: "FULL",
      expectedContainerStateVersion: 0,
      checkInId
    });
    const { previewEventGap } = await import("@/lib/server/gaps");
    const firstPreview = await previewEventGap(firstInput);
    await createEvent(
      { ...firstInput, gapVersion: firstPreview.gapVersion },
      { ...actor, role: "OPERATOR" }
    );

    await expect(
      createEvent(
        {
          ...firstInput,
          startTime: "06:20",
          endTime: "06:30",
          container: "ABCU1234578"
        },
        { ...actor, role: "OPERATOR" }
      )
    ).rejects.toMatchObject({ status: 409, code: "CHECKIN_NOT_CALLED" });
  });

  it("returns a linked check-in to CHAMADO on manager deletion and relinks it on admin restore", async () => {
    process.env.CHECKIN_INTEGRATION_MODE = "observe";
    inMemoryAdminDb.seed("clients", "client-1", {
      active: true,
      name: "Cliente 1"
    });
    inMemoryAdminDb.seed("checkins", checkInId, {
      id: checkInId,
      status: "CHAMADO",
      plate: "ABC1D23",
      version: 10,
      activeProductiveEventId: null,
      updatedAtIso: "2026-07-27T08:00:00.000Z"
    });
    const input = eventInput({
      category: "PRODUTIVO",
      clientId: "client-1",
      plate: "ABC1D23",
      container: "ABCU1234560",
      containerStatus: "FULL",
      expectedContainerStateVersion: 0,
      checkInId
    });
    const { previewEventGap } = await import("@/lib/server/gaps");
    const creationPreview = await previewEventGap(input);
    const created = await createEvent(
      { ...input, gapVersion: creationPreview.gapVersion },
      actor
    );
    const deletion = await prepareDeletionGap(created.id);

    await softDeleteEvent(
      created.id,
      "Seleção incorreta da carreta",
      managerActor,
      { gapVersion: deletion.preview.gapVersion }
    );

    expect(inMemoryAdminDb.read("checkins", checkInId)).toMatchObject({
      status: "CHAMADO",
      activeProductiveEventId: null,
      version: 12
    });
    expect(
      inMemoryAdminDb.entries(`checkins/${checkInId}/revisions`)[1]?.[1]
    ).toMatchObject({
      action: "PRODUCTIVE_EVENT_UNLINKED",
      eventId: created.id,
      actorRole: "SUPERVISOR",
      reason: "Seleção incorreta da carreta",
      previousStatus: "EM_DESCARGA",
      newStatus: "CHAMADO",
      previousVersion: 11,
      newVersion: 12
    });

    const restorePreview = await previewEventRestore(created.id);
    await restoreEvent(
      created.id,
      { uid: "admin-1", email: "admin@example.com", role: "ADMIN" },
      {
        gapVersion: restorePreview.gapVersion,
        expectedContainerStateVersion:
          restorePreview.expectedContainerStateVersion
      }
    );

    expect(inMemoryAdminDb.read("checkins", checkInId)).toMatchObject({
      status: "EM_DESCARGA",
      activeProductiveEventId: created.id,
      version: 13
    });
    expect(
      inMemoryAdminDb.entries(`checkins/${checkInId}/revisions`)[2]?.[1]
    ).toMatchObject({
      action: "PRODUCTIVE_EVENT_RESTORED",
      eventId: created.id,
      actorRole: "ADMIN",
      previousStatus: "CHAMADO",
      newStatus: "EM_DESCARGA",
      previousVersion: 12,
      newVersion: 13
    });
  });

  it("does not let an edit detach a linked productive event from its canonical plate", async () => {
    process.env.CHECKIN_INTEGRATION_MODE = "observe";
    inMemoryAdminDb.seed("clients", "client-1", {
      active: true,
      name: "Cliente 1"
    });
    inMemoryAdminDb.seed("checkins", checkInId, {
      id: checkInId,
      status: "CHAMADO",
      plate: "ABC1D23",
      version: 1,
      activeProductiveEventId: null,
      updatedAtIso: "2026-07-27T08:00:00.000Z"
    });
    const input = eventInput({
      category: "PRODUTIVO",
      clientId: "client-1",
      plate: "ABC1D23",
      container: "ABCU1234560",
      containerStatus: "FULL",
      expectedContainerStateVersion: 0,
      checkInId
    });
    const { previewEventGap } = await import("@/lib/server/gaps");
    const preview = await previewEventGap(input);
    const created = await createEvent(
      { ...input, gapVersion: preview.gapVersion },
      actor
    );

    await expect(
      updateEvent(
        created.id,
        eventInput({
          category: "PRODUTIVO",
          clientId: "client-1",
          plate: "ZZZ9999",
          container: "ABCU1234560",
          containerStatus: "FULL",
          expectedContainerStateVersion: 1,
          revisionReason: "Troca manual da placa"
        }),
        { ...managerActor }
      )
    ).rejects.toMatchObject({ status: 409 });

    expect(inMemoryAdminDb.read("events", created.id)).toMatchObject({
      checkInId,
      plate: "ABC-1D23",
      deleted: false
    });
    expect(inMemoryAdminDb.read("checkins", checkInId)).toMatchObject({
      status: "EM_DESCARGA",
      activeProductiveEventId: created.id
    });
  });

  it("creates a manual event and returns its normalized public representation", async () => {
    const created = await createEvent(eventInput(), actor);

    expect(created).toMatchObject({
      id: "generated-1",
      pump: "BOMBA_1",
      category: "OUTROS",
      productive: false,
      origin: "MANUAL",
      deleted: false,
      notes: "Preparação operacional",
      warnings: []
    });
    expect(inMemoryAdminDb.read("timelineLocks", "2026-07-27_MANHA_BOMBA_1"))
      .toMatchObject({ version: 1 });
  });

  it("creates a productive event with client validation and an automatic tolerated gap", async () => {
    inMemoryAdminDb.seed("clients", "client-1", {
      active: true,
      name: "Cliente 1"
    });
    await createEvent(
      eventInput({
        startTime: "06:00",
        endTime: "06:10"
      }),
      actor
    );

    const previewInput = eventInput({
      startTime: "06:15",
      endTime: "06:30",
      category: "PRODUTIVO",
      clientId: "client-1",
      plate: "abc1234",
      container: "ABCU1234560",
      containerStatus: "FULL",
      expectedContainerStateVersion: 0,
      notes: null
    });
    const { previewEventGap } = await import("@/lib/server/gaps");
    const preview = await previewEventGap(previewInput);
    const productive = await createEvent(
      {
        ...previewInput,
        gapVersion: preview.gapVersion
      },
      actor
    );

    expect(productive).toMatchObject({
      productive: true,
      clientNameSnapshot: "Cliente 1",
      plate: "ABC-1234"
    });
    const generated = inMemoryAdminDb
      .entries("events")
      .map(([id, data]) => ({ id, ...data }))
      .find((item) => Reflect.get(item, "origin") === "AUTO_GAP");
    expect(generated).toMatchObject({
      category: "INTERVALO_OPERACIONAL",
      startTime: "06:10",
      endTime: "06:15",
      generatedForEventId: productive.id,
      justificationWaived: true
    });
  });

  it("rejects invalid creation commands before committing any writes", async () => {
    await expect(
      createEvent(
        eventInput({ category: "INTERVALO_OPERACIONAL" }),
        actor
      )
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      createEvent(
        eventInput({
          category: "PRODUTIVO",
          clientId: "missing",
          plate: "ABC1234",
          container: "ABCU1234560"
        }),
        actor
      )
    ).rejects.toMatchObject({ status: 400 });
    expect(inMemoryAdminDb.entries("events")).toHaveLength(0);
  });

  it("detects overlap and stale gap previews without a partial commit", async () => {
    await createEvent(eventInput(), actor);

    await expect(
      createEvent(
        eventInput({
          startTime: "06:05",
          endTime: "06:20",
          notes: "Sobreposição"
        }),
        actor
      )
    ).rejects.toMatchObject({ status: 409 });

    inMemoryAdminDb.seed("clients", "client-1", {
      active: true,
      name: "Cliente"
    });
    await expect(
      createEvent(
        eventInput({
          startTime: "06:20",
          endTime: "06:30",
          category: "PRODUTIVO",
          clientId: "client-1",
          plate: "ABC1234",
          container: "ABCU1234560",
          expectedContainerStateVersion: 0,
          notes: null,
          gapVersion: "stale"
        }),
        actor
      )
    ).rejects.toMatchObject({ status: 409 });
    expect(inMemoryAdminDb.entries("events")).toHaveLength(1);
  });

  it("requires independently valid justifications for material idle gaps", async () => {
    inMemoryAdminDb.seed("clients", "client-1", {
      active: true,
      name: "Cliente 1"
    });
    const firstInput = eventInput({
      category: "PRODUTIVO",
      clientId: "client-1",
      plate: "ABC1234",
      container: "ABCU1234560",
      expectedContainerStateVersion: 0,
      notes: null
    });
    const { previewEventGap } = await import("@/lib/server/gaps");
    const firstPreview = await previewEventGap(firstInput);
    await createEvent(
      { ...firstInput, gapVersion: firstPreview.gapVersion },
      actor
    );

    const nextInput = eventInput({
      startTime: "06:30",
      endTime: "06:45",
      category: "PRODUTIVO",
      clientId: "client-1",
      plate: "ABC1234",
      container: "ABCU1234560",
      startsNewContainerCycle: true,
      expectedContainerStateVersion: 1,
      notes: null
    });
    const preview = await previewEventGap(nextInput);
    const segment = preview.uncoveredSegments[0];
    expect(preview.requiresJustification).toBe(true);

    await expect(
      createEvent({ ...nextInput, gapVersion: preview.gapVersion }, actor)
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      createEvent(
        {
          ...nextInput,
          gapVersion: preview.gapVersion,
          gapJustifications: [null]
        },
        actor
      )
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      createEvent(
        {
          ...nextInput,
          gapVersion: preview.gapVersion,
          gapJustifications: [
            {
              ...segment,
              category: "PRODUTIVO"
            }
          ]
        },
        actor
      )
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      createEvent(
        {
          ...nextInput,
          gapVersion: preview.gapVersion,
          gapJustifications: [
            {
              ...segment,
              category: "EM_TRANSITO",
              clientId: null,
              plate: null,
              notes: null
            }
          ]
        },
        actor
      )
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      createEvent(
        {
          ...nextInput,
          gapVersion: preview.gapVersion,
          gapJustifications: [
            {
              ...segment,
              category: "EM_TRANSITO",
              clientId: "client-1",
              plate: null,
              notes: null
            }
          ]
        },
        actor
      )
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      createEvent(
        {
          ...nextInput,
          gapVersion: preview.gapVersion,
          gapJustifications: [
            {
              ...segment,
              category: "EM_TRANSITO",
              clientId: "client-1",
              plate: "XYZ1234",
              notes: null
            }
          ]
        },
        actor
      )
    ).rejects.toMatchObject({ status: 400 });

    const created = await createEvent(
      {
        ...nextInput,
        gapVersion: preview.gapVersion,
        gapJustifications: [
          {
            ...segment,
            category: "EM_TRANSITO",
            clientId: " client-1 ",
            plate: " xyz1234 ",
            notes: " deslocamento "
          }
        ]
      },
      actor
    );
    const automatic = inMemoryAdminDb
      .entries("events")
      .map(([, data]) => data)
      .find(
        (data) =>
          data.origin === "AUTO_GAP" &&
          data.generatedForEventId === created.id
      );
    expect(automatic).toMatchObject({
      category: "EM_TRANSITO",
      clientId: "client-1",
      plate: "XYZ1234",
      notes: "deslocamento",
      justificationWaived: false,
      clientNameSnapshot: "Cliente 1"
    });
  });

  it("requires and persists laboratory client, plate and waiting truck count", async () => {
    inMemoryAdminDb.seed("clients", "client-1", {
      active: true,
      name: "Cliente 1"
    });
    const firstInput = eventInput({
      category: "PRODUTIVO",
      clientId: "client-1",
      plate: "ABC1234",
      container: "ABCU1234560",
      expectedContainerStateVersion: 0,
      notes: null
    });
    const { previewEventGap } = await import("@/lib/server/gaps");
    const firstPreview = await previewEventGap(firstInput);
    await createEvent(
      { ...firstInput, gapVersion: firstPreview.gapVersion },
      actor
    );

    const nextInput = eventInput({
      startTime: "06:30",
      endTime: "06:45",
      category: "PRODUTIVO",
      clientId: "client-1",
      plate: "ABC1234",
      container: "ABCU1234560",
      startsNewContainerCycle: true,
      expectedContainerStateVersion: 1,
      notes: null
    });
    const preview = await previewEventGap(nextInput);
    const segment = preview.uncoveredSegments[0];

    await expect(
      createEvent(
        {
          ...nextInput,
          gapVersion: preview.gapVersion,
          gapJustifications: [
            {
              ...segment,
              category: "AGUARDANDO_LABORATORIO",
              clientId: "client-1",
              plate: null,
              notes: "3 carretas aguardando"
            }
          ]
        },
        actor
      )
    ).rejects.toMatchObject({ status: 400 });

    const created = await createEvent(
      {
        ...nextInput,
        gapVersion: preview.gapVersion,
        gapJustifications: [
          {
            ...segment,
            category: "AGUARDANDO_LABORATORIO",
            clientId: "client-1",
            plate: "XYZ1234",
            notes: "3 carretas aguardando"
          }
        ]
      },
      actor
    );
    const automatic = inMemoryAdminDb
      .entries("events")
      .map(([, data]) => data)
      .find(
        (data) =>
          data.origin === "AUTO_GAP" &&
          data.generatedForEventId === created.id
      );

    expect(automatic).toMatchObject({
      category: "AGUARDANDO_LABORATORIO",
      clientId: "client-1",
      plate: "XYZ1234",
      notes: "3 carretas aguardando",
      justificationWaived: false
    });
  });

  it("rejects inactive clients at the domain boundary", async () => {
    inMemoryAdminDb.seed("clients", "inactive", {
      active: false,
      name: "Inativo"
    });
    await expect(
      createEvent(
        eventInput({
          category: "PRODUTIVO",
          clientId: "inactive",
          plate: "ABC1234",
          container: "ABCU1234560",
          notes: null
        }),
        actor
      )
    ).rejects.toMatchObject({ status: 400 });
  });

  it("updates a manual event and records an audit revision atomically", async () => {
    const created = await createEvent(eventInput(), actor);
    const updated = await updateEvent(
      created.id,
      eventInput({ notes: "Preparação concluída" }),
      { ...actor, role: "ADMIN" }
    );

    expect(updated).toMatchObject({
      id: created.id,
      notes: "Preparação concluída"
    });
    const revisions = inMemoryAdminDb.entries(
      `events/${created.id}/revisions`
    );
    expect(revisions).toHaveLength(1);
    expect(revisions[0][1]).toMatchObject({
      editedByUid: actor.uid,
      changedFields: expect.arrayContaining(["notes"])
    });
  });

  it("requires a revision reason when an edit changes timeline fields", async () => {
    const created = await createEvent(eventInput(), actor);

    await expect(
      updateEvent(
        created.id,
        eventInput({ startTime: "06:01", endTime: "06:10" }),
        { ...actor, role: "ADMIN" }
      )
    ).rejects.toMatchObject({ status: 400 });
    expect(inMemoryAdminDb.read("events", created.id)).toMatchObject({
      startTime: "06:00"
    });
  });

  it("deletes and restores an event through the reconciliation preview", async () => {
    const created = await createEvent(
      eventInput({ pump: "BOMBA_2" }),
      actor
    );
    const deletion = await prepareDeletionGap(created.id);

    await expect(
      softDeleteEvent(
        created.id,
        "Registro duplicado",
        managerActor,
        { gapVersion: deletion.preview.gapVersion }
      )
    ).resolves.toEqual({ ok: true });
    expect(inMemoryAdminDb.read("events", created.id)).toMatchObject({
      deleted: true,
      deletedReason: "Registro duplicado"
    });

    const preview = await previewEventRestore(created.id);
    expect(preview).toMatchObject({
      changedSinceDeletion: false,
      expectedContainerStateVersion: null,
      reconciliations: []
    });

    await expect(
      restoreEvent(
        created.id,
        { uid: "admin-1", email: "admin@example.com", role: "ADMIN" },
        { gapVersion: preview.gapVersion }
      )
    ).resolves.toEqual({ ok: true });
    expect(inMemoryAdminDb.read("events", created.id)).toMatchObject({
      deleted: false,
      deletedReason: null,
      deletionTimelineVersion: null
    });
  });

  it("guards deletion and restoration invalid states", async () => {
    await expect(
      softDeleteEvent("missing", "motivo", managerActor)
    ).rejects.toMatchObject({ status: 404 });

    const created = await createEvent(
      eventInput({ pump: "BOMBA_3" }),
      actor
    );
    await expect(
      softDeleteEvent(created.id, "   ", managerActor)
    ).rejects.toMatchObject({ status: 400 });
    await expect(previewEventRestore(created.id)).rejects.toMatchObject({
      status: 400
    });
  });

  it("lists role-scoped events and container passage history through the public query", async () => {
    const own = await createEvent(eventInput(), actor);
    await createEvent(
      eventInput({
        pump: "BOMBA_2",
        createdByUid: undefined,
        notes: "Outro evento"
      }),
      { uid: "operator-2", email: "second@example.com", role: "OPERATOR" }
    );

    const ownEvents = await listEvents({
      role: "OPERATOR",
      uid: actor.uid,
      filters: {},
      pagination: { limit: 20 }
    });
    expect(ownEvents.items.map((event) => event.id)).toEqual([own.id]);
    expect(ownEvents.items[0].previousContainerPassages).toEqual([]);

    const adminEvents = await listEvents({
      role: "ADMIN",
      uid: "admin",
      filters: {},
      pagination: { limit: 20 }
    });
    expect(adminEvents.items).toHaveLength(2);
  });
});
