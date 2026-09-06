import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  PRODUCTION_BACKFILL_CONFIRMATION,
  buildContainerStateBackfillCandidates,
  buildContainerStateBackfillPatch,
  parseArgs,
  selectBackfillRecords,
  validateBackfillRequest
} from "../../scripts/backfill-container-states.mjs";

describe("container state backfill CLI policy", () => {
  it("preserves independent legacy cycles that predate explicit container status", () => {
    const records = [1, 2].map((sequence) => ({
      id: `legacy-${sequence}`,
      data: {
        category: "PRODUTIVO", container: "ABCU 123456-0", clientId: "client",
        containerCycleId: `existing-${sequence}`, previousContainerEventId: null,
        startsNewContainerCycle: false, pump: "BOMBA_1", plate: "ABC-1234",
        endAt: `2026-07-2${sequence}T10:00:00.000Z`, createdAt: `2026-07-2${sequence}T10:01:00.000Z`
      }
    }));
    expect(buildContainerStateBackfillCandidates(records).get("ABCU1234560")).toMatchObject({
      id: "legacy-2", status: "FULL", data: { containerCycleId: "existing-2", previousContainerEventId: null }
    });
  });
  it("reports invalid legacy identifiers without changing events or ignoring invalid modern transfers", () => {
    const valid = { id: "valid", data: { category: "PRODUTIVO", container: "ABCU 123456-0", clientId: "client" } };
    const invalid = { id: "old", data: { category: "PRODUTIVO", container: "TEST 123456-7", clientId: "client" } };
    const original = structuredClone([valid, invalid]);
    const selected = selectBackfillRecords([valid, invalid]);
    expect(selected.records).toEqual([valid]);
    expect(selected.skippedLegacy).toEqual([expect.objectContaining({ id: "old", container: "TEST 123456-7" })]);
    expect([valid, invalid]).toEqual(original);
    expect(() => selectBackfillRecords([{ ...invalid, data: { ...invalid.data, loadSourceType: "BUFFER_CONTAINER" } }])).toThrow("Container inválido");
  });
  it("awaits the direct CLI execution before Node can exit", () => {
    const source = readFileSync(
      "scripts/backfill-container-states.mjs",
      "utf8"
    );

    expect(source).toMatch(
      /if \(isDirectInvocation\) \{\s+try \{\s+await main\(\);/
    );
  });

  it("defaults to dry-run and rejects ambiguous write requests", () => {
    const options = parseArgs(["--project=line-transbordo-staging-382612"]);

    expect(options).toMatchObject({
      projectId: "line-transbordo-staging-382612",
      execute: false,
      dryRun: true
    });
    expect(() => validateBackfillRequest(options)).not.toThrow();

    expect(() =>
      validateBackfillRequest({
        ...options,
        execute: true,
        dryRun: false,
        confirmation: "wrong-project"
      })
    ).toThrow("--confirm-project=line-transbordo-staging-382612");
  });

  it("requires an additional explicit production acknowledgement", () => {
    const options = parseArgs([
      "--project=line-transbordo",
      "--execute",
      "--confirm-project=line-transbordo",
      "--allow-production",
      `--confirm-production=${PRODUCTION_BACKFILL_CONFIRMATION}`
    ]);

    expect(() => validateBackfillRequest(options)).not.toThrow();

    expect(() =>
      validateBackfillRequest({
        ...options,
        allowProduction: false
      })
    ).toThrow("Produção bloqueada");

    expect(() =>
      validateBackfillRequest({
        ...options,
        productionConfirmation: null
      })
    ).toThrow(`--confirm-production=${PRODUCTION_BACKFILL_CONFIRMATION}`);
  });

  it("increments an existing state version when materializing a projection", () => {
    const patch = buildContainerStateBackfillPatch({
      existing: { version: 7 },
      eventId: "event-1",
      key: "ABCU1234560",
      status: "FULL",
      data: {
        container: "ABCU 123456-0",
        containerReason: null,
        containerCycleId: "cycle-1",
        previousContainerEventId: "event-0",
        clientId: "client-1",
        clientNameSnapshot: "Cliente",
        plate: "AAA-1A23",
        pump: "BOMBA_1",
        endAt: "2026-07-27T10:00:00.000Z",
        createdAt: "2026-07-27T09:00:00.000Z",
        updatedAt: "2026-07-27T09:05:00.000Z"
      }
    });

    if (!patch) {
      throw new Error("Expected backfill patch to be materialized.");
    }
    expect(patch).toMatchObject({
      latestEventId: "event-1",
      previousEventId: "event-0",
      version: 8
    });
  });

  it("preserves the version when an idempotent rerun produces the same projection", () => {
    const data = {
      container: "ABCU 123456-0",
      containerReason: null,
      containerCycleId: "cycle-1",
      previousContainerEventId: "event-0",
      clientId: "client-1",
      clientNameSnapshot: "Cliente",
      plate: "AAA-1A23",
      pump: "BOMBA_1",
      endAt: "2026-07-27T10:00:00.000Z",
      createdAt: "2026-07-27T09:00:00.000Z",
      updatedAt: "2026-07-27T09:05:00.000Z"
    };
    const first = buildContainerStateBackfillPatch({
      existing: undefined,
      eventId: "event-1",
      key: "ABCU1234560",
      status: "FULL",
      data
    });
    if (!first) {
      throw new Error(
        "Expected the initial backfill patch to be materialized."
      );
    }
    const rerun = buildContainerStateBackfillPatch({
      existing: first,
      eventId: "event-1",
      key: "ABCU1234560",
      status: "FULL",
      data
    });

    if (!rerun) {
      throw new Error(
        "Expected idempotent backfill patches to be materialized."
      );
    }
    expect(first.version).toBe(1);
    expect(rerun.version).toBe(1);
    expect(rerun).toEqual(first);
  });

  it("does not overwrite a newer existing state with an older projection", () => {
    const patch = buildContainerStateBackfillPatch({
      existing: {
        version: 3,
        latestEventId: "event-newer",
        operationalAt: "2026-07-27T10:30:00.000Z",
        eventCreatedAt: "2026-07-27T10:35:00.000Z"
      },
      eventId: "event-older",
      key: "ABCU1234560",
      status: "FULL",
      data: {
        container: "ABCU 123456-0",
        containerReason: null,
        containerCycleId: "cycle-1",
        previousContainerEventId: "event-0",
        clientId: "client-1",
        clientNameSnapshot: "Cliente",
        plate: "AAA-1A23",
        pump: "BOMBA_1",
        endAt: "2026-07-27T10:00:00.000Z",
        createdAt: "2026-07-27T10:05:00.000Z",
        updatedAt: "2026-07-27T10:05:00.000Z"
      }
    });

    expect(patch).toBeNull();
  });

  it("reconstructs both sides of a container transfer without requiring a truck plate", () => {
    const candidates = buildContainerStateBackfillCandidates([
      {
        id: "buffer-created",
        data: {
          category: "PRODUTIVO",
          container: "MSCU 663987-0",
          containerStatus: "BUFFER",
          containerReason: "Reserva operacional",
          containerCycleId: "cycle-source",
          clientId: "client-1",
          clientNameSnapshot: "Cliente",
          plate: "AAA-1A23",
          pump: "BOMBA_1",
          endAt: "2026-07-27T08:00:00.000Z",
          createdAt: "2026-07-27T08:01:00.000Z"
        }
      },
      {
        id: "transfer",
        data: {
          category: "PRODUTIVO",
          loadSourceType: "BUFFER_CONTAINER",
          sourceContainer: "MSCU 663987-0",
          sourceContainerEmptied: false,
          sourceContainerCycleId: "cycle-source",
          previousSourceContainerEventId: "buffer-created",
          container: "ABCU 123456-0",
          containerStatus: "FULL",
          containerCycleId: "cycle-destination",
          clientId: "client-1",
          clientNameSnapshot: "Cliente",
          plate: null,
          pump: "BOMBA_1",
          endAt: "2026-07-27T09:00:00.000Z",
          createdAt: "2026-07-27T09:01:00.000Z"
        }
      }
    ]);

    expect(candidates.get("MSCU6639870")).toMatchObject({
      id: "transfer",
      status: "BUFFER",
      data: {
        container: "MSCU 663987-0",
        plate: "AAA-1A23",
        latestEventRole: "SOURCE",
        relatedContainer: "ABCU 123456-0"
      }
    });
    expect(candidates.get("ABCU1234560")).toMatchObject({
      id: "transfer",
      status: "FULL",
      data: {
        plate: null,
        latestEventRole: "DESTINATION",
        relatedContainer: "MSCU 663987-0"
      }
    });
  });

  it("marks an emptied source as terminal during reconstruction", () => {
    const candidates = buildContainerStateBackfillCandidates([
      {
        id: "source",
        data: {
          category: "PRODUTIVO",
          container: "MSCU 663987-0",
          containerStatus: "PARTIAL",
          containerCycleId: "cycle-source",
          clientId: "client-1",
          pump: "BOMBA_2",
          endAt: "2026-07-27T08:00:00.000Z",
          createdAt: "2026-07-27T08:01:00.000Z"
        }
      },
      {
        id: "transfer",
        data: {
          category: "PRODUTIVO",
          loadSourceType: "BUFFER_CONTAINER",
          sourceContainer: "MSCU 663987-0",
          sourceContainerEmptied: true,
          sourceContainerCycleId: "cycle-source",
          container: "ABCU 123456-0",
          containerStatus: "PARTIAL",
          containerCycleId: "cycle-destination",
          clientId: "client-1",
          plate: null,
          pump: "BOMBA_2",
          endAt: "2026-07-27T09:00:00.000Z",
          createdAt: "2026-07-27T09:01:00.000Z"
        }
      }
    ]);

    expect(candidates.get("MSCU6639870")?.status).toBe("TRANSFER_EMPTIED");
  });
});
