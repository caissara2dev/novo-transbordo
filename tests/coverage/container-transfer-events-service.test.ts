import { beforeEach, describe, expect, it, vi } from "vitest";
import { inMemoryAdminDb } from "./in-memory-firestore";

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: inMemoryAdminDb
}));

import {
  createEvent,
  previewEventRestore,
  restoreEvent,
  softDeleteEvent,
  updateEvent
} from "@/lib/server/events";
import { prepareDeletionGap } from "@/lib/server/gaps";

const actor = {
  uid: "operator-1",
  email: "operator@example.com",
  role: "ADMIN"
} as const;

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

describe("container transfer event command service", () => {
  beforeEach(() => {
    process.env.CHECKIN_INTEGRATION_MODE = "off";
    process.env.CHECKIN_INTEGRATION_KEY_ID = "checkin-v1";
    process.env.CHECKIN_INTEGRATION_HMAC_SECRET = "a".repeat(32);
    process.env.CHECKIN_INDEX_HMAC_SECRET = "b".repeat(32);
    process.env.CHECKIN_GEOFENCE_CENTER_LAT = "-23.9608";
    process.env.CHECKIN_GEOFENCE_CENTER_LNG = "-46.3336";
    process.env.CHECKIN_POWER_AUTOMATE_ADD_URL =
      "https://include.environment.api.powerplatform.com/checkins/add";
    process.env.CHECKIN_POWER_AUTOMATE_UPDATE_URL =
      "https://update.environment.api.powerplatform.com/checkins/update";
    process.env.CHECKIN_POWER_AUTOMATE_AUTH_MODE = "entra-client-credentials";
    process.env.CHECKIN_POWER_AUTOMATE_TENANT_ID =
      "11111111-1111-4111-8111-111111111111";
    process.env.CHECKIN_POWER_AUTOMATE_CLIENT_ID =
      "22222222-2222-4222-8222-222222222222";
    process.env.CHECKIN_POWER_AUTOMATE_CLIENT_SECRET = "c".repeat(32);
    process.env.CHECKIN_ENFORCE_ROLLOUT_APPROVED = "true";
    inMemoryAdminDb.reset();
    inMemoryAdminDb.seed("settings", "operations", {
      idleToleranceMinutes: 10
    });
  });

  it("rejects linking a called truck check-in to a container transfer", async () => {
    process.env.CHECKIN_INTEGRATION_MODE = "observe";
    const checkInId = "11111111-1111-4111-8111-111111111111";
    inMemoryAdminDb.seed("clients", "client-1", {
      active: true,
      name: "Cliente 1"
    });
    inMemoryAdminDb.seed("checkins", checkInId, {
      id: checkInId,
      status: "CHAMADO",
      plate: "ABC1D23",
      version: 3
    });

    await expect(
      createEvent(
        eventInput({
          category: "PRODUTIVO",
          clientId: "client-1",
          container: "ABCU1234560",
          containerStatus: "FULL",
          loadSourceType: "BUFFER_CONTAINER",
          sourceContainer: "MSCU6639870",
          sourceContainerEmptied: false,
          expectedSourceContainerStateVersion: 1,
          checkInId,
          notes: null
        }),
        actor
      )
    ).rejects.toMatchObject({ status: 400 });

    expect(inMemoryAdminDb.entries("events")).toEqual([]);
    expect(inMemoryAdminDb.read("checkins", checkInId)).toMatchObject({
      status: "CHAMADO",
      version: 3
    });
  });

  it("moves load from an open buffer container into one destination without duplicating the productive event", async () => {
    inMemoryAdminDb.seed("clients", "client-1", {
      active: true,
      name: "Cliente 1"
    });
    const sourceInput = eventInput({
        startTime: "06:00",
        endTime: "06:10",
        category: "PRODUTIVO",
        clientId: "client-1",
        plate: "ABC1234",
        container: "MSCU6639870",
        containerStatus: "BUFFER",
        containerReason: "Reserva operacional",
        expectedContainerStateVersion: 0,
        notes: null
      });
    const { previewEventGap } = await import("@/lib/server/gaps");
    const sourcePreview = await previewEventGap(sourceInput);
    await createEvent(
      { ...sourceInput, gapVersion: sourcePreview.gapVersion },
      actor
    );
    process.env.CHECKIN_INTEGRATION_MODE = "enforce";
    const transferInput = eventInput({
      startTime: "06:10",
      endTime: "06:25",
      category: "PRODUTIVO",
      clientId: "client-1",
      plate: null,
      container: "ABCU1234560",
      containerStatus: "PARTIAL",
      containerReason: "Ainda receberá complemento",
      expectedContainerStateVersion: 0,
      loadSourceType: "BUFFER_CONTAINER",
      sourceContainer: "MSCU6639870",
      sourceContainerEmptied: false,
      expectedSourceContainerStateVersion: 1,
      notes: null
    });
    const preview = await previewEventGap(transferInput);
    const transfer = await createEvent(
      { ...transferInput, gapVersion: preview.gapVersion },
      actor
    );

    expect(transfer).toMatchObject({
      loadSourceType: "BUFFER_CONTAINER",
      sourceContainer: "MSCU 663987-0",
      sourceContainerEmptied: false,
      plate: null
    });
    expect(inMemoryAdminDb.read("containerStates", "MSCU6639870")).toMatchObject({
      status: "BUFFER",
      latestEventId: transfer.id,
      latestEventRole: "SOURCE",
      relatedContainer: "ABCU 123456-0"
    });
    expect(inMemoryAdminDb.read("containerStates", "ABCU1234560")).toMatchObject({
      status: "PARTIAL",
      latestEventId: transfer.id,
      latestEventRole: "DESTINATION",
      relatedContainer: "MSCU 663987-0"
    });
    expect(
      inMemoryAdminDb
        .entries("events")
        .filter(([, data]) => Reflect.get(data, "productive"))
    ).toHaveLength(2);
  });

  it("closes the source cycle when a buffer container is emptied by transfer", async () => {
    inMemoryAdminDb.seed("clients", "client-1", {
      active: true,
      name: "Cliente 1"
    });
    const sourceInput = eventInput({
        startTime: "06:00",
        endTime: "06:10",
        category: "PRODUTIVO",
        clientId: "client-1",
        plate: "ABC1234",
        container: "MSCU6639870",
        containerStatus: "BUFFER",
        containerReason: "Reserva operacional",
        expectedContainerStateVersion: 0,
        notes: null
      });
    const { previewEventGap } = await import("@/lib/server/gaps");
    const sourcePreview = await previewEventGap(sourceInput);
    await createEvent(
      { ...sourceInput, gapVersion: sourcePreview.gapVersion },
      actor
    );
    const transferInput = eventInput({
      startTime: "06:10",
      endTime: "06:20",
      category: "PRODUTIVO",
      clientId: "client-1",
      plate: null,
      container: "ABCU1234560",
      containerStatus: "FULL",
      expectedContainerStateVersion: 0,
      loadSourceType: "BUFFER_CONTAINER",
      sourceContainer: "MSCU6639870",
      sourceContainerEmptied: true,
      expectedSourceContainerStateVersion: 1,
      notes: null
    });
    const preview = await previewEventGap(transferInput);
    const transfer = await createEvent(
      { ...transferInput, gapVersion: preview.gapVersion },
      actor
    );

    expect(inMemoryAdminDb.read("containerStates", "MSCU6639870")).toMatchObject({
      status: "TRANSFER_EMPTIED",
      latestEventId: transfer.id
    });
  });

  it.each([
    ["BUFFER", false],
    ["BLEND_FULL", true],
    ["BLEND_PARTIAL", true]
  ] as const)(
    "supports %s as the transfer destination state",
    async (destinationStatus, requiresOpenDestination) => {
      inMemoryAdminDb.seed("clients", "client-1", {
        active: true,
        name: "Cliente 1"
      });
      const { previewEventGap } = await import("@/lib/server/gaps");
      const createWithPreview = async (input: Record<string, unknown>) => {
        const preview = await previewEventGap(input);
        return createEvent({ ...input, gapVersion: preview.gapVersion }, actor);
      };
      await createWithPreview(eventInput({
        pump: "BOMBA_1",
        startTime: "06:00",
        endTime: "06:05",
        category: "PRODUTIVO",
        clientId: "client-1",
        plate: "ABC1234",
        container: "MSCU6639870",
        containerStatus: "BUFFER",
        containerReason: "Reserva operacional",
        expectedContainerStateVersion: 0,
        notes: null
      }));
      if (requiresOpenDestination) {
        await createWithPreview(eventInput({
          pump: "BOMBA_2",
          startTime: "06:00",
          endTime: "06:05",
          category: "PRODUTIVO",
          clientId: "client-1",
          plate: "DEF5678",
          container: "ABCU1234560",
          containerStatus: "PARTIAL",
          containerReason: "Aguardando complemento",
          expectedContainerStateVersion: 0,
          notes: null
        }));
      }

      const transfer = await createWithPreview(eventInput({
        pump: "BOMBA_3",
        startTime: "06:05",
        endTime: "06:10",
        category: "PRODUTIVO",
        clientId: "client-1",
        plate: null,
        container: "ABCU1234560",
        containerStatus: destinationStatus,
        containerReason:
          destinationStatus === "BUFFER" || destinationStatus === "BLEND_PARTIAL"
            ? "Ainda receberá complemento"
            : null,
        blendConfirmed: destinationStatus.startsWith("BLEND_"),
        expectedContainerStateVersion: requiresOpenDestination ? 1 : 0,
        loadSourceType: "BUFFER_CONTAINER",
        sourceContainer: "MSCU6639870",
        sourceContainerEmptied: false,
        expectedSourceContainerStateVersion: 1,
        notes: null
      }));

      expect(inMemoryAdminDb.read("containerStates", "ABCU1234560")).toMatchObject({
        latestEventId: transfer.id,
        status: destinationStatus
      });
      expect(inMemoryAdminDb.read("containerStates", "MSCU6639870")).toMatchObject({
        latestEventId: transfer.id,
        status: "BUFFER"
      });
    }
  );

  it("rejects a stale buffer source without partially creating the destination", async () => {
    inMemoryAdminDb.seed("clients", "client-1", {
      active: true,
      name: "Cliente 1"
    });
    const sourceInput = eventInput({
      startTime: "06:00",
      endTime: "06:10",
      category: "PRODUTIVO",
      clientId: "client-1",
      plate: "ABC1234",
      container: "MSCU6639870",
      containerStatus: "BUFFER",
      containerReason: "Reserva operacional",
      expectedContainerStateVersion: 0,
      notes: null
    });
    const { previewEventGap } = await import("@/lib/server/gaps");
    const sourcePreview = await previewEventGap(sourceInput);
    await createEvent(
      { ...sourceInput, gapVersion: sourcePreview.gapVersion },
      actor
    );
    const transferInput = eventInput({
      startTime: "06:10",
      endTime: "06:20",
      category: "PRODUTIVO",
      clientId: "client-1",
      plate: null,
      container: "ABCU1234560",
      containerStatus: "FULL",
      expectedContainerStateVersion: 0,
      loadSourceType: "BUFFER_CONTAINER",
      sourceContainer: "MSCU6639870",
      sourceContainerEmptied: true,
      expectedSourceContainerStateVersion: 0,
      notes: null
    });
    const preview = await previewEventGap(transferInput);

    await expect(
      createEvent({ ...transferInput, gapVersion: preview.gapVersion }, actor)
    ).rejects.toMatchObject({ status: 409 });
    expect(inMemoryAdminDb.read("containerStates", "ABCU1234560")).toBeUndefined();
    expect(inMemoryAdminDb.entries("events")).toHaveLength(1);
  });

  it("rejects a transfer when the open source state belongs to another client", async () => {
    inMemoryAdminDb.seed("clients", "client-1", {
      active: true,
      name: "Cliente 1"
    });
    const sourceInput = eventInput({
      startTime: "06:00",
      endTime: "06:10",
      category: "PRODUTIVO",
      clientId: "client-1",
      plate: "ABC1234",
      container: "MSCU6639870",
      containerStatus: "BUFFER",
      containerReason: "Reserva operacional",
      expectedContainerStateVersion: 0,
      notes: null
    });
    const { previewEventGap } = await import("@/lib/server/gaps");
    const sourcePreview = await previewEventGap(sourceInput);
    await createEvent(
      { ...sourceInput, gapVersion: sourcePreview.gapVersion },
      actor
    );
    inMemoryAdminDb.seed("containerStates", "MSCU6639870", {
      ...inMemoryAdminDb.read("containerStates", "MSCU6639870"),
      clientId: "client-2"
    });
    const transferInput = eventInput({
      startTime: "06:10",
      endTime: "06:20",
      category: "PRODUTIVO",
      clientId: "client-1",
      plate: null,
      container: "ABCU1234560",
      containerStatus: "FULL",
      expectedContainerStateVersion: 0,
      loadSourceType: "BUFFER_CONTAINER",
      sourceContainer: "MSCU6639870",
      sourceContainerEmptied: true,
      expectedSourceContainerStateVersion: 1,
      notes: null
    });
    const preview = await previewEventGap(transferInput);

    await expect(
      createEvent({ ...transferInput, gapVersion: preview.gapVersion }, actor)
    ).rejects.toMatchObject({ status: 400 });
    expect(inMemoryAdminDb.read("containerStates", "ABCU1234560")).toBeUndefined();
  });

  it("rejects a historical buffer that is no longer open when the transfer is created", async () => {
    inMemoryAdminDb.seed("clients", "client-1", {
      active: true,
      name: "Cliente 1"
    });
    const { previewEventGap } = await import("@/lib/server/gaps");
    const sourceInput = eventInput({
      startTime: "06:00",
      endTime: "06:10",
      category: "PRODUTIVO",
      clientId: "client-1",
      plate: "ABC1234",
      container: "MSCU6639870",
      containerStatus: "BUFFER",
      containerReason: "Reserva operacional",
      expectedContainerStateVersion: 0,
      notes: null
    });
    const sourcePreview = await previewEventGap(sourceInput);
    await createEvent(
      { ...sourceInput, gapVersion: sourcePreview.gapVersion },
      actor
    );
    const closedInput = eventInput({
      startTime: "06:20",
      endTime: "06:30",
      category: "PRODUTIVO",
      clientId: "client-1",
      plate: "ABC1234",
      container: "MSCU6639870",
      containerStatus: "FULL",
      expectedContainerStateVersion: 1,
      notes: null
    });
    const closedPreview = await previewEventGap(closedInput);
    await createEvent(
      { ...closedInput, gapVersion: closedPreview.gapVersion },
      actor
    );
    const transferInput = eventInput({
      pump: "BOMBA_2",
      startTime: "06:10",
      endTime: "06:15",
      category: "PRODUTIVO",
      clientId: "client-1",
      plate: null,
      container: "ABCU1234560",
      containerStatus: "FULL",
      expectedContainerStateVersion: 0,
      loadSourceType: "BUFFER_CONTAINER",
      sourceContainer: "MSCU6639870",
      sourceContainerEmptied: false,
      expectedSourceContainerStateVersion: 2,
      notes: null
    });
    const transferPreview = await previewEventGap(transferInput);

    await expect(
      createEvent(
        { ...transferInput, gapVersion: transferPreview.gapVersion },
        actor
      )
    ).rejects.toMatchObject({ status: 409 });
    expect(inMemoryAdminDb.read("containerStates", "ABCU1234560")).toBeUndefined();
  });

  it("edits a transfer and reconciles the destination and source together", async () => {
    inMemoryAdminDb.seed("clients", "client-1", {
      active: true,
      name: "Cliente 1"
    });
    inMemoryAdminDb.seed("clients", "client-2", {
      active: true,
      name: "Cliente 2"
    });
    const sourceInput = eventInput({
      startTime: "06:00",
      endTime: "06:10",
      category: "PRODUTIVO",
      clientId: "client-1",
      plate: "ABC1234",
      container: "MSCU6639870",
      containerStatus: "BUFFER",
      containerReason: "Reserva operacional",
      expectedContainerStateVersion: 0,
      notes: null
    });
    const { previewEventGap } = await import("@/lib/server/gaps");
    const sourcePreview = await previewEventGap(sourceInput);
    await createEvent(
      { ...sourceInput, gapVersion: sourcePreview.gapVersion },
      actor
    );
    const transferInput = eventInput({
      startTime: "06:10",
      endTime: "06:20",
      category: "PRODUTIVO",
      clientId: "client-1",
      plate: null,
      container: "ABCU1234560",
      containerStatus: "PARTIAL",
      containerReason: "Ainda receberá complemento",
      expectedContainerStateVersion: 0,
      loadSourceType: "BUFFER_CONTAINER",
      sourceContainer: "MSCU6639870",
      sourceContainerEmptied: false,
      expectedSourceContainerStateVersion: 1,
      notes: null
    });
    const transferPreview = await previewEventGap(transferInput);
    const transfer = await createEvent(
      { ...transferInput, gapVersion: transferPreview.gapVersion },
      actor
    );
    const editedInput = {
      ...transferInput,
      sourceContainerEmptied: true,
      expectedContainerStateVersion: 1,
      expectedSourceContainerStateVersion: 2,
      revisionReason: "Origem foi totalmente esvaziada"
    };
    const editPreview = await previewEventGap({
      ...editedInput,
      eventId: transfer.id
    });
    await updateEvent(
      transfer.id,
      { ...editedInput, gapVersion: editPreview.gapVersion },
      { ...actor, role: "ADMIN" }
    );

    expect(inMemoryAdminDb.read("containerStates", "ABCU1234560")).toMatchObject({
      status: "PARTIAL"
    });
    expect(inMemoryAdminDb.read("containerStates", "MSCU6639870")).toMatchObject({
      status: "TRANSFER_EMPTIED"
    });
    expect(inMemoryAdminDb.entries(`events/${transfer.id}/revisions`)[0][1])
      .toMatchObject({
        reason: "Origem foi totalmente esvaziada",
        changedFields: expect.arrayContaining(["sourceContainerEmptied"])
      });

    const mismatchedClientInput = {
      ...editedInput,
      clientId: "client-2",
      expectedContainerStateVersion: 2,
      expectedSourceContainerStateVersion: 3,
      revisionReason: "Tentativa inválida de trocar o cliente"
    };
    const mismatchPreview = await previewEventGap({
      ...mismatchedClientInput,
      eventId: transfer.id
    });
    await expect(
      updateEvent(
        transfer.id,
        { ...mismatchedClientInput, gapVersion: mismatchPreview.gapVersion },
        actor
      )
    ).rejects.toMatchObject({ status: 400 });
    expect(inMemoryAdminDb.read("events", transfer.id)).toMatchObject({
      clientId: "client-1",
      sourceContainerEmptied: true
    });
    expect(inMemoryAdminDb.read("containerStates", "MSCU6639870")).toMatchObject({
      clientId: "client-1",
      status: "TRANSFER_EMPTIED",
      version: 3
    });
  });

  it("deletes and restores both sides of a container transfer", async () => {
    inMemoryAdminDb.seed("clients", "client-1", {
      active: true,
      name: "Cliente 1"
    });
    const sourceInput = eventInput({
      startTime: "06:00",
      endTime: "06:10",
      category: "PRODUTIVO",
      clientId: "client-1",
      plate: "ABC1234",
      container: "MSCU6639870",
      containerStatus: "BUFFER",
      containerReason: "Reserva operacional",
      expectedContainerStateVersion: 0,
      notes: null
    });
    const { previewEventGap } = await import("@/lib/server/gaps");
    const sourcePreview = await previewEventGap(sourceInput);
    await createEvent(
      { ...sourceInput, gapVersion: sourcePreview.gapVersion },
      actor
    );
    const transferInput = eventInput({
      startTime: "06:10",
      endTime: "06:20",
      category: "PRODUTIVO",
      clientId: "client-1",
      plate: null,
      container: "ABCU1234560",
      containerStatus: "FULL",
      expectedContainerStateVersion: 0,
      loadSourceType: "BUFFER_CONTAINER",
      sourceContainer: "MSCU6639870",
      sourceContainerEmptied: true,
      expectedSourceContainerStateVersion: 1,
      notes: null
    });
    const transferPreview = await previewEventGap(transferInput);
    const transfer = await createEvent(
      { ...transferInput, gapVersion: transferPreview.gapVersion },
      actor
    );
    const deletion = await prepareDeletionGap(transfer.id);
    await softDeleteEvent(
      transfer.id,
      "Transferência lançada incorretamente",
      actor,
      { gapVersion: deletion.preview.gapVersion }
    );

    expect(inMemoryAdminDb.read("containerStates", "ABCU1234560")).toBeUndefined();
    expect(inMemoryAdminDb.read("containerStates", "MSCU6639870")).toMatchObject({
      status: "BUFFER"
    });

    const restorePreview = await previewEventRestore(transfer.id);
    await restoreEvent(
      transfer.id,
      actor,
      {
        gapVersion: restorePreview.gapVersion,
        expectedContainerStateVersion:
          restorePreview.expectedContainerStateVersion,
        expectedSourceContainerStateVersion:
          restorePreview.expectedSourceContainerStateVersion
      }
    );
    expect(inMemoryAdminDb.read("containerStates", "ABCU1234560")).toMatchObject({
      status: "FULL",
      latestEventId: transfer.id
    });
    expect(inMemoryAdminDb.read("containerStates", "MSCU6639870")).toMatchObject({
      status: "TRANSFER_EMPTIED",
      latestEventId: transfer.id
    });
  });

  it("restores a historical transfer even after the source started a newer cycle", async () => {
    inMemoryAdminDb.seed("clients", "client-1", {
      active: true,
      name: "Cliente 1"
    });
    const { previewEventGap } = await import("@/lib/server/gaps");
    const sourceInput = eventInput({
      startTime: "06:00",
      endTime: "06:10",
      category: "PRODUTIVO",
      clientId: "client-1",
      plate: "ABC1234",
      container: "MSCU6639870",
      containerStatus: "BUFFER",
      containerReason: "Reserva operacional",
      expectedContainerStateVersion: 0,
      notes: null
    });
    const sourcePreview = await previewEventGap(sourceInput);
    await createEvent(
      { ...sourceInput, gapVersion: sourcePreview.gapVersion },
      actor
    );
    const transferInput = eventInput({
      startTime: "06:10",
      endTime: "06:20",
      category: "PRODUTIVO",
      clientId: "client-1",
      plate: null,
      container: "ABCU1234560",
      containerStatus: "FULL",
      expectedContainerStateVersion: 0,
      loadSourceType: "BUFFER_CONTAINER",
      sourceContainer: "MSCU6639870",
      sourceContainerEmptied: true,
      expectedSourceContainerStateVersion: 1,
      notes: null
    });
    const transferPreview = await previewEventGap(transferInput);
    const transfer = await createEvent(
      { ...transferInput, gapVersion: transferPreview.gapVersion },
      actor
    );
    const deletion = await prepareDeletionGap(transfer.id);
    await softDeleteEvent(
      transfer.id,
      "Transferência lançada incorretamente",
      actor,
      { gapVersion: deletion.preview.gapVersion }
    );

    inMemoryAdminDb.seed("settings", "operations", {
      idleToleranceMinutes: 60
    });
    const newerInput = eventInput({
      pump: "BOMBA_2",
      startTime: "06:20",
      endTime: "06:30",
      category: "PRODUTIVO",
      clientId: "client-1",
      plate: "DEF5678",
      container: "MSCU6639870",
      containerStatus: "PARTIAL",
      containerReason: "Novo ciclo",
      startsNewContainerCycle: true,
      expectedContainerStateVersion: 3,
      notes: null
    });
    const newerPreview = await previewEventGap(newerInput);
    const newer = await createEvent(
      { ...newerInput, gapVersion: newerPreview.gapVersion },
      actor
    );
    const restorePreview = await previewEventRestore(transfer.id);

    await restoreEvent(transfer.id, actor, {
      gapVersion: restorePreview.gapVersion,
      expectedContainerStateVersion:
        restorePreview.expectedContainerStateVersion,
      expectedSourceContainerStateVersion:
        restorePreview.expectedSourceContainerStateVersion
    });

    expect(inMemoryAdminDb.read("containerStates", "MSCU6639870")).toMatchObject({
      status: "PARTIAL",
      latestEventId: newer.id
    });
    expect(inMemoryAdminDb.read("events", transfer.id)).toMatchObject({
      deleted: false,
      sourceContainerCycleId: expect.any(String)
    });
  });
});
