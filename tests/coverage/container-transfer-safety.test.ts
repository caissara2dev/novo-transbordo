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
