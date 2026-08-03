import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  PRODUCTION_BACKFILL_CONFIRMATION,
  buildContainerStateBackfillPatch,
  parseArgs,
  validateBackfillRequest
} from "../../scripts/backfill-container-states.mjs";

describe("container state backfill CLI policy", () => {
  it("awaits the direct CLI execution before Node can exit", () => {
    const source = readFileSync("scripts/backfill-container-states.mjs", "utf8");

    expect(source).toMatch(/if \(isDirectInvocation\) \{\s+try \{\s+await main\(\);/);
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
      throw new Error("Expected the initial backfill patch to be materialized.");
    }
    const rerun = buildContainerStateBackfillPatch({
      existing: first,
      eventId: "event-1",
      key: "ABCU1234560",
      status: "FULL",
      data
    });

    if (!rerun) {
      throw new Error("Expected idempotent backfill patches to be materialized.");
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
});
