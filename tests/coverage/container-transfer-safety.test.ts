import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inMemoryAdminDb } from "./in-memory-firestore";
vi.mock("@/lib/firebase/admin", () => ({ adminDb: inMemoryAdminDb }));
import {
  createEvent,
  updateEvent,
  softDeleteEvent,
  previewEventRestore,
  restoreEvent,
  listEvents
} from "@/lib/server/events";
import { previewEventGap, prepareDeletionGap } from "@/lib/server/gaps";
import {
  getContainerHistory,
  getCurrentContainerState
} from "@/lib/server/container-states";
import { containerTransfersEnabled } from "@/lib/server/container-transfer-capability";
import { buildContainerStateBackfillCandidates } from "../../scripts/backfill-container-states.mjs";
import * as policies from "@/lib/server/events/policies";

const actor = {
  uid: "admin",
  email: "admin@example.com",
  role: "ADMIN" as const
};
const input = (overrides: Record<string, unknown> = {}) => ({
  pump: "BOMBA_1",
  shiftDate: "2026-07-27",
  shiftType: "MANHA",
  startTime: "06:00",
  endTime: "06:10",
  category: "PRODUTIVO",
  clientId: "client",
  plate: "ABC1234",
  container: "MSCU6639870",
  containerStatus: "PARTIAL",
  containerReason: "Aguardando complemento",
  expectedContainerStateVersion: 0,
  notes: null,
  ...overrides
});
const transferInput = () =>
  input({
    startTime: "06:10",
    endTime: "06:20",
    plate: null,
    container: "ABCU1234560",
    loadSourceType: "BUFFER_CONTAINER",
    sourceContainer: "MSCU6639870",
    sourceContainerEmptied: false,
    expectedSourceContainerStateVersion: 1
  });
async function create(raw: Record<string, unknown>) {
  const preview = await previewEventGap(raw);
  return createEvent({ ...raw, gapVersion: preview.gapVersion }, actor);
}

describe("transfer replay and rollback through event commands", () => {
  beforeEach(() => {
    inMemoryAdminDb.reset();
    inMemoryAdminDb.seed("clients", "client", {
      active: true,
      name: "Cliente Teste"
    });
    inMemoryAdminDb.seed("settings", "operations", {
      idleToleranceMinutes: 60
    });
  });
  afterEach(() => vi.unstubAllEnvs());
  it.each(["delete", "restore"])("rejects %s after the selected event changes", async (operation) => {
    await create(input());
    const transfer = await create(transferInput());
    const deletion = await prepareDeletionGap(transfer.id);
    if (operation === "restore") await softDeleteEvent(transfer.id, "QA", actor, { gapVersion: deletion.preview.gapVersion });
    const restore = operation === "restore" ? await previewEventRestore(transfer.id) : null;
    const run = inMemoryAdminDb.runTransaction.bind(inMemoryAdminDb);
    const transaction = vi.spyOn(inMemoryAdminDb, "runTransaction").mockImplementationOnce(async (callback) => {
      await inMemoryAdminDb.collection("events").doc(transfer.id).update({ notes: "Alteração concorrente" });
      return run(callback);
    });
    try {
      await expect(operation === "restore"
        ? restoreEvent(transfer.id, actor, restore!)
        : softDeleteEvent(transfer.id, "QA", actor, { gapVersion: deletion.preview.gapVersion })
      ).rejects.toThrow(operation === "restore" ? "mudou durante a restauração" : "mudou durante a exclusão");
      expect(inMemoryAdminDb.read("events", transfer.id)?.deleted).toBe(operation === "restore");
    } finally { transaction.mockRestore(); }
  });
  it("rejects an edit whose event changed before the pump locks were read", async () => {
    await create(input());
    await create(input({ pump: "BOMBA_2", container: "TSTU2500019" }));
    const transfer = await create(transferInput());
    const changedOrigin = {
      ...transferInput(),
      sourceContainer: "TSTU2500019",
      expectedContainerStateVersion: 1,
      revisionReason: "Correção da origem"
    };
    const preview = await previewEventGap({
      ...changedOrigin,
      eventId: transfer.id
    });
    const clientCheck = vi.spyOn(policies, "assertClientIfRequired");
    clientCheck.mockImplementationOnce(async () => {
      await updateEvent(
        transfer.id,
        { ...changedOrigin, gapVersion: preview.gapVersion },
        actor
      );
      return null;
    });
    try {
      await expect(
        updateEvent(
          transfer.id,
          {
            ...transferInput(),
            category: "OUTROS",
            clientId: null,
            container: null,
            loadSourceType: null,
            sourceContainer: null,
            notes: "Correção para ociosidade",
            revisionReason: "Sem operação produtiva"
          },
          actor
        )
      ).rejects.toThrow("O lançamento mudou durante a edição");
      expect(inMemoryAdminDb.read("events", transfer.id)?.sourceContainer).toBe(
        "TSTU 250001-9"
      );
      expect(await getCurrentContainerState("TSTU2500019")).toMatchObject({
        latestEventId: transfer.id,
        latestEventRole: "SOURCE"
      });
    } finally {
      clientCheck.mockRestore();
    }
  });
  it.each([
    [false, false], [false, true], [true, false], [true, true]
  ])("binds retroactive creation to the selected current cycle (emptied=%s, explicit=%s)", async (emptied, explicit) => {
    await create(input());
    await create(input({
      startTime: "06:20", endTime: "06:30", containerStatus: "FULL",
      expectedContainerStateVersion: 1
    }));
    await create(input({
      startTime: "06:30", endTime: "06:40", startsNewContainerCycle: true,
      expectedContainerStateVersion: 2
    }));
    const current = await getCurrentContainerState("MSCU6639870");
    const before = inMemoryAdminDb.entries("events");
    await expect(create({
      ...transferInput(), pump: "BOMBA_2", sourceContainerEmptied: emptied,
      expectedSourceContainerStateVersion: current!.version,
      ...(explicit ? { expectedSourceContainerCycleId: current!.cycleId } : {})
    })).rejects.toThrow("ciclo de origem selecionado");
    expect(inMemoryAdminDb.entries("events")).toEqual(before);
    expect(await getCurrentContainerState("MSCU6639870")).toEqual(current);
    expect(await getCurrentContainerState("ABCU1234560")).toBeNull();
  });
  it("rejects moving a current-cycle transfer into an older source cycle", async () => {
    await create(input());
    await create(input({
      startTime: "06:20", endTime: "06:30", containerStatus: "FULL",
      expectedContainerStateVersion: 1
    }));
    await create(input({
      startTime: "06:30", endTime: "06:40", startsNewContainerCycle: true,
      expectedContainerStateVersion: 2
    }));
    const current = await getCurrentContainerState("MSCU6639870");
    const raw = {
      ...transferInput(), pump: "BOMBA_2", startTime: "06:40", endTime: "06:50",
      expectedSourceContainerStateVersion: current!.version,
      expectedSourceContainerCycleId: current!.cycleId
    };
    const transfer = await create(raw);
    expect(inMemoryAdminDb.read("events", transfer.id)?.sourceContainerCycleId).toBe(current!.cycleId);
    expect(inMemoryAdminDb.read("events", transfer.id)).not.toHaveProperty("expectedSourceContainerCycleId");
    const edited = {
      ...raw, startTime: "06:10", endTime: "06:20",
      expectedContainerStateVersion: 1, expectedSourceContainerStateVersion: 4,
      revisionReason: "Correção retroativa"
    };
    const preview = await previewEventGap({ ...edited, eventId: transfer.id });
    await expect(updateEvent(transfer.id, { ...edited, gapVersion: preview.gapVersion }, actor))
      .rejects.toThrow("ciclo de origem selecionado");
    expect(inMemoryAdminDb.read("events", transfer.id)?.startTime).toBe("06:40");
  });
  it("preserves historical edits and restoration when the same source has a new cycle", async () => {
    await create(input());
    const originalCycle = (await getCurrentContainerState("MSCU6639870"))!.cycleId;
    const raw = { ...transferInput(), expectedSourceContainerCycleId: originalCycle };
    const transfer = await create(raw);
    await create(input({
      startTime: "06:20", endTime: "06:30", containerStatus: "FULL",
      expectedContainerStateVersion: 2
    }));
    await create(input({
      startTime: "06:30", endTime: "06:40", startsNewContainerCycle: true,
      expectedContainerStateVersion: 3
    }));
    const current = await getCurrentContainerState("MSCU6639870");
    expect(current!.cycleId).not.toBe(originalCycle);
    const edited = {
      ...raw, expectedContainerStateVersion: 1,
      expectedSourceContainerStateVersion: current!.version,
      revisionReason: "Correção no ciclo histórico", notes: "Auditado"
    };
    const preview = await previewEventGap({ ...edited, eventId: transfer.id });
    await updateEvent(transfer.id, { ...edited, gapVersion: preview.gapVersion }, actor);
    expect(inMemoryAdminDb.read("events", transfer.id)?.sourceContainerCycleId).toBe(originalCycle);
    const reselected = {
      ...edited, expectedContainerStateVersion: 2, expectedSourceContainerStateVersion: 5,
      expectedSourceContainerCycleId: current!.cycleId
    };
    const reselectPreview = await previewEventGap({ ...reselected, eventId: transfer.id });
    await expect(updateEvent(transfer.id, { ...reselected, gapVersion: reselectPreview.gapVersion }, actor))
      .rejects.toThrow("ciclo de origem selecionado");
    const deletion = await prepareDeletionGap(transfer.id);
    await softDeleteEvent(transfer.id, "Teste do ciclo histórico", actor, { gapVersion: deletion.preview.gapVersion });
    await restoreEvent(transfer.id, actor, await previewEventRestore(transfer.id));
    expect(inMemoryAdminDb.read("events", transfer.id)?.sourceContainerCycleId).toBe(originalCycle);
    expect((await getCurrentContainerState("MSCU6639870"))!.cycleId).toBe(current!.cycleId);
  });
  it("defaults to disabled without configuration", () => {
    vi.stubEnv("CONTAINER_TRANSFERS_ENABLED", undefined);
    expect(containerTransfersEnabled()).toBe(false);
  });
  it("blocks creation while independent truck operations remain available", async () => {
    await create(input());
    vi.stubEnv("CONTAINER_TRANSFERS_ENABLED", "false");
    await expect(create(transferInput())).rejects.toThrow(
      "temporariamente indisponíveis"
    );
    expect(inMemoryAdminDb.entries("events")).toHaveLength(1);
    await expect(
      create(
        input({
          startTime: "06:10",
          endTime: "06:20",
          container: "ABCU1234560"
        })
      )
    ).resolves.toHaveProperty("id");
  });
  it("blocks update, delete and restore and keeps history readable", async () => {
    await create(input());
    const transfer = await create(transferInput());
    const edited = {
      ...transferInput(),
      sourceContainerEmptied: true,
      expectedContainerStateVersion: 1,
      expectedSourceContainerStateVersion: 2,
      revisionReason: "Correção"
    };
    const preview = await previewEventGap({ ...edited, eventId: transfer.id });
    const deletion = await prepareDeletionGap(transfer.id);
    vi.stubEnv("CONTAINER_TRANSFERS_ENABLED", "false");
    await expect(
      updateEvent(
        transfer.id,
        { ...edited, gapVersion: preview.gapVersion },
        actor
      )
    ).rejects.toThrow("temporariamente indisponíveis");
    await expect(
      softDeleteEvent(transfer.id, "Correção", actor, {
        gapVersion: deletion.preview.gapVersion
      })
    ).rejects.toThrow("temporariamente indisponíveis");
    await expect(
      getContainerHistory("MSCU6639870").then((page) => page.items)
    ).resolves.toHaveLength(2);
    vi.stubEnv("CONTAINER_TRANSFERS_ENABLED", "true");
    await softDeleteEvent(transfer.id, "Correção", actor, {
      gapVersion: deletion.preview.gapVersion
    });
    const restorePreview = await previewEventRestore(transfer.id);
    vi.stubEnv("CONTAINER_TRANSFERS_ENABLED", "false");
    await expect(
      restoreEvent(transfer.id, actor, restorePreview)
    ).rejects.toThrow("temporariamente indisponíveis");
    expect(inMemoryAdminDb.read("events", transfer.id)?.deleted).toBe(true);
  });
  it("blocks a truck mutation that would reconstruct an existing transfer", async () => {
    const source = await create(input());
    await create(transferInput());
    const edited = {
      ...input(),
      expectedContainerStateVersion: 2,
      revisionReason: "Correção do motivo"
    };
    const preview = await previewEventGap({ ...edited, eventId: source.id });
    vi.stubEnv("CONTAINER_TRANSFERS_ENABLED", "false");
    await expect(
      updateEvent(
        source.id,
        { ...edited, gapVersion: preview.gapVersion },
        actor
      )
    ).rejects.toThrow("temporariamente indisponíveis");
  });
  it("keeps replay, histories and backfill consistent after a retroactive source-state edit", async () => {
    const source = await create(input());
    const transfer = await create(transferInput());
    const edited = {
      ...input(),
      containerStatus: "BUFFER",
      expectedContainerStateVersion: 2,
      revisionReason: "Origem era Pulmão"
    };
    const preview = await previewEventGap({ ...edited, eventId: source.id });
    await updateEvent(
      source.id,
      { ...edited, gapVersion: preview.gapVersion },
      actor
    );
    expect((await getContainerHistory("MSCU6639870")).items[0]).toMatchObject({
      id: transfer.id,
      status: "BUFFER"
    });
    expect(await getCurrentContainerState("MSCU6639870")).toMatchObject({
      status: "BUFFER"
    });
    const candidates = buildContainerStateBackfillCandidates(
      inMemoryAdminDb.entries("events").map(([id, data]) => ({ id, data }))
    );
    expect(candidates.get("MSCU6639870")).toMatchObject({
      id: transfer.id,
      status: "BUFFER"
    });
  });
  it("renders a source passage using that container's cycle and status in global history", async () => {
    await create(input());
    const transfer = await create(transferInput());
    const follow = await create(
      input({
        startTime: "06:20",
        endTime: "06:30",
        expectedContainerStateVersion: 2
      })
    );
    const page = await listEvents({
      role: "ADMIN",
      uid: actor.uid,
      filters: {},
      pagination: { limit: 20 }
    });
    expect(
      page.items.find((item) => item.id === follow.id)
        ?.previousContainerPassages
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: transfer.id,
          role: "SOURCE",
          status: "PARTIAL",
          relatedContainer: "ABCU 123456-0"
        })
      ])
    );
  });
});
