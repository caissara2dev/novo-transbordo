import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { parseArgs, planUpdate, RESOURCE, run, saveSnapshot, waitOperation } from "../../scripts/homologation/update-worker-billing.cjs";

const project = "line-transbordo-staging-382612";

describe("worker deployment billing regression", () => {
  it("emits explicit request-based CPU allocation in the actual deployment request", async () => {
    const calls: { method: string; body: unknown }[] = [];
    const request = vi.fn(async (_host, _path, method = "GET", body) => {
      calls.push({ method, body });
      return { name: "existing-service" };
    });
    const errors: unknown[] = [];
    const script = readFileSync(resolve("scripts/homologation/deploy-worker.cjs"), "utf8");
    await runInNewContext(script, {
      require: (name: string) => {
        if (name === "./cloud.cjs") return { project, request };
        if (name === "node:fs") return {
          readFileSync: () => JSON.stringify({ image: "image@sha256:abc" }),
          writeFileSync: vi.fn()
        };
        throw new Error(`Unexpected module ${name}`);
      },
      console: { log: vi.fn(), error: (...args: unknown[]) => errors.push(args) },
      process: { exitCode: 0 }
    });
    expect(errors).toEqual([]);
    const patch = calls.find((call) => call.method === "PATCH")?.body;
    expect(patch).toMatchObject({
      template: { containers: [{ resources: { cpuIdle: true, limits: { cpu: "1", memory: "1Gi" } } }] }
    });
  });
});

const oldRevisionName = `${RESOURCE}/revisions/checkin-document-worker-00002-abc`;
const newRevisionName = `${RESOURCE}/revisions/checkin-document-worker-00003-def`;
const image = `us-central1-docker.pkg.dev/${project}/checkin-nf/preview:v1`;
const digest = "a".repeat(64);
function fixture() {
  return {
    name: RESOURCE,
    etag: '"v1"',
    terminalCondition: { state: "CONDITION_SUCCEEDED" },
    latestCreatedRevision: oldRevisionName,
    latestReadyRevision: oldRevisionName,
    traffic: [{ type: "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", percent: 100 }],
    trafficStatuses: [{ type: "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", percent: 100 }],
    scaling: { maxInstanceCount: 20 },
    template: {
      serviceAccount: `checkin-document-worker@${project}.iam.gserviceaccount.com`,
      timeout: "240s",
      maxInstanceRequestConcurrency: 1,
      scaling: { maxInstanceCount: 1 },
      containers: [{
        image,
        resources: { limits: { cpu: "1", memory: "1Gi" } },
        env: [{ name: "KEPT", value: "unchanged" }],
        ports: [{ containerPort: 8080 }],
        startupProbe: { tcpSocket: { port: 8080 }, timeoutSeconds: 240 }
      }]
    }
  };
}
function revision(name = oldRevisionName, ready = false) {
  return {
    name,
    conditions: [{ type: "Ready", state: "CONDITION_SUCCEEDED" }],
    containers: [{ image: image.split(":v1")[0] + `@sha256:${digest}`, resources: { cpuIdle: ready } }]
  };
}
function updated() {
  const before = fixture();
  return {
    ...before, etag: '"v2"', latestCreatedRevision: newRevisionName, latestReadyRevision: newRevisionName,
    template: { ...before.template, containers: planUpdate(before)!.template.containers }
  };
}
function validation() {
  return {
    name: `projects/${project}/locations/us-central1/operations/non-persisted`,
    metadata: {
      ...fixture(), "@type": "type.googleapis.com/google.cloud.run.v2.Service",
      reconciling: true, terminalCondition: { type: "Ready", state: "CONDITION_PENDING" },
      template: { ...fixture().template, containers: planUpdate(fixture())!.template.containers }
    }
  };
}

describe("scoped worker billing update", () => {
  it("defaults to simulation and refuses other projects, regions, services and unknown arguments", () => {
    expect(parseArgs([])).toMatchObject({ apply: false, project, region: "us-central1", service: "checkin-document-worker" });
    for (const arg of ["--project=line-transbordo", "--region=southamerica-east1", "--service=checkin-system-nf", "--force", "--apply=1", "--evidence-dir"]) {
      expect(() => parseArgs([arg])).toThrow();
    }
    expect(() => parseArgs(["--apply"])).toThrow("evidence-dir");
    expect(() => parseArgs(["--apply", "--apply", "--evidence-dir=/tmp/private"])).toThrow("duplicado");
  });

  it("rejects wrong resource, unstable state, missing etag and unexpected container configuration", () => {
    const invalid = [
      { ...fixture(), name: RESOURCE.replace(project, "line-transbordo") },
      { ...fixture(), etag: undefined },
      { ...fixture(), reconciling: true },
      { ...fixture(), terminalCondition: { state: "CONDITION_FAILED" } },
      { ...fixture(), latestReadyRevision: newRevisionName },
      { ...fixture(), trafficStatuses: [{ type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION", percent: 100 }] },
      { ...fixture(), template: { ...fixture().template, timeout: "600s" } },
      { ...fixture(), template: { ...fixture().template, containers: [] } },
      { ...fixture(), template: { ...fixture().template, scaling: { minInstanceCount: 1, maxInstanceCount: 1 } } },
      { ...fixture(), template: { ...fixture().template, containers: [{ image, resources: { limits: { cpu: "2", memory: "1Gi" } } }] } }
    ];
    for (const service of invalid) expect(() => planUpdate(service)).toThrow();
    expect(() => planUpdate(null)).toThrow("ausente");
  });

  it("preserves the complete container config and emits only etag/name/containers with the scoped mask", async () => {
    const before = fixture();
    const untouched = structuredClone(before);
    const request = vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(revision()).mockResolvedValueOnce(validation());
    const result = await run(parseArgs([]), { request });
    expect(result.status).toBe("validated");
    expect(request).toHaveBeenCalledTimes(3);
    const [host, endpoint, method, body] = request.mock.calls[2];
    expect(host).toBe("run.googleapis.com");
    expect(endpoint).toBe(`/v2/${RESOURCE}?updateMask=template.containers&validateOnly=true`);
    expect(method).toBe("PATCH");
    const expected = structuredClone(before.template.containers);
    Object.assign(expected[0].resources, { cpuIdle: true });
    expect(body).toEqual({ name: RESOURCE, etag: before.etag, template: { containers: expected } });
    expect(before).toEqual(untouched);
  });

  it("captures rollback evidence before validation, checks etag, applies once and verifies digest and ready traffic", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(fixture())
      .mockResolvedValueOnce(revision())
      .mockResolvedValueOnce(validation())
      .mockResolvedValueOnce(fixture())
      .mockResolvedValueOnce({ done: true })
      .mockResolvedValueOnce(updated())
      .mockResolvedValueOnce(revision(newRevisionName, true));
    const save = vi.fn((_directory, snapshot) => {
      expect(request).toHaveBeenCalledTimes(2);
      expect(snapshot.service).toEqual(fixture());
      expect(snapshot.revision).toEqual(revision());
      expect(snapshot.digest).toBe(digest);
      return "/tmp/private/before.json";
    });
    const result = await run(parseArgs(["--apply", "--evidence-dir=/tmp/private"]), { request, saveSnapshot: save });
    expect(result).toMatchObject({ status: "updated", revision: newRevisionName, digest, snapshotPath: "/tmp/private/before.json" });
    const mutation = request.mock.calls[4];
    expect(mutation.slice(0, 3)).toEqual(["run.googleapis.com", `/v2/${RESOURCE}?updateMask=template.containers`, "PATCH"]);
    expect(mutation[3]).toEqual(request.mock.calls[2][3]);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("is idempotent and never validates, patches or creates a new revision if already correct", async () => {
    const request = vi.fn().mockResolvedValueOnce(updated()).mockResolvedValueOnce(revision(newRevisionName, true));
    const save = vi.fn();
    expect(await run(parseArgs(["--apply", "--evidence-dir=/tmp/private"]), { request, saveSnapshot: save })).toMatchObject({ status: "already-correct", revision: newRevisionName });
    expect(request).toHaveBeenCalledTimes(2);
    expect(save).not.toHaveBeenCalled();
  });

  it("refuses a concurrent change after validation without issuing a mutation", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(fixture()).mockResolvedValueOnce(revision())
      .mockResolvedValueOnce(validation()).mockResolvedValueOnce({ ...fixture(), etag: '"concurrent"' });
    await expect(run(parseArgs(["--apply", "--evidence-dir=/tmp/private"]), { request, saveSnapshot: () => "/tmp/snapshot" })).rejects.toThrow("mudou durante");
    expect(request).toHaveBeenCalledTimes(4);
    expect(request.mock.calls.filter((call) => call[2] === "PATCH").every((call) => call[1].includes("validateOnly=true"))).toBe(true);
  });

  it("does not retry a server-side etag conflict or validation failure", async () => {
    for (const failureIndex of [2, 4]) {
      const replies = [fixture(), revision(), validation(), fixture(), { done: true }];
      const request = vi.fn();
      for (let i = 0; i <= failureIndex; i++) {
        if (i === failureIndex) request.mockRejectedValueOnce(new Error("409 ABORTED etag conflict"));
        else request.mockResolvedValueOnce(replies[i]);
      }
      await expect(run(parseArgs(["--apply", "--evidence-dir=/tmp/private"]), { request, saveSnapshot: () => "/tmp/snapshot" })).rejects.toThrow("etag conflict");
      expect(request).toHaveBeenCalledTimes(failureIndex + 1);
    }
  });

  it("refuses an error returned inside the validation operation even when HTTP succeeded", async () => {
    const request = vi.fn().mockResolvedValueOnce(fixture()).mockResolvedValueOnce(revision())
      .mockResolvedValueOnce({ done: true, error: { code: 400 } });
    await expect(run(parseArgs([]), { request })).rejects.toThrow("400");
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("accepts the non-persisted Cloud Run validation operation without polling its synthetic name", async () => {
    const request = vi.fn().mockResolvedValueOnce(fixture()).mockResolvedValueOnce(revision())
      .mockResolvedValueOnce(validation()).mockRejectedValue(new Error("404 synthetic operation was never persisted"));
    const result = await run(parseArgs([]), { request, sleep: async () => undefined });
    expect(result.status).toBe("validated");
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("refuses an empty validation response or a preview with an unexpected resource or containers", async () => {
    const wrongResource = validation();
    wrongResource.metadata.name = "projects/production/locations/us-central1/services/wrong";
    const wrongContainers = validation();
    wrongContainers.metadata.template.containers[0].resources.cpuIdle = false;
    for (const preview of [{ done: true }, wrongResource, wrongContainers]) {
      const request = vi.fn().mockResolvedValueOnce(fixture()).mockResolvedValueOnce(revision()).mockResolvedValueOnce(preview);
      await expect(run(parseArgs([]), { request })).rejects.toThrow("validateOnly inesperada");
      expect(request).toHaveBeenCalledTimes(3);
    }
  });

  it("requires the new revision to preserve the image digest and CPU allocation", async () => {
    const wrong = revision(newRevisionName, true);
    wrong.containers[0].image = wrong.containers[0].image.replace(digest, "b".repeat(64));
    const request = vi.fn();
    for (const reply of [fixture(), revision(), validation(), fixture(), { done: true }, updated(), wrong]) request.mockResolvedValueOnce(reply);
    await expect(run(parseArgs(["--apply", "--evidence-dir=/tmp/private"]), { request, saveSnapshot: () => "/tmp/snapshot" })).rejects.toThrow("Verificação final falhou");
  });

  it("waits only for an allowlisted operation and stops on errors or timeout", async () => {
    const name = `projects/${project}/locations/us-central1/operations/op1`;
    const request = vi.fn().mockResolvedValue({ done: true });
    await waitOperation({ name }, request, { now: () => 0, timeoutMs: 5000, sleep: vi.fn() });
    expect(request).toHaveBeenCalledWith("run.googleapis.com", `/v2/${name}`);
    await expect(waitOperation({ name: "projects/production/operations/op1" }, request, { now: () => 0, timeoutMs: 100, sleep: vi.fn() })).rejects.toThrow("fora do destino");
    await expect(waitOperation({ done: true, error: { code: 409 } }, request, { now: () => 0, timeoutMs: 100, sleep: vi.fn() })).rejects.toThrow("409");
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(101);
    await expect(waitOperation({ name }, request, { now, timeoutMs: 100, sleep: vi.fn() })).rejects.toThrow("Tempo limite");
  });

  it("writes a complete private snapshot and refuses a public evidence directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "worker-billing-test-"));
    const snapshot = { capturedAt: "2026-09-15T19:00:00.000Z", service: fixture(), revision: revision(), digest };
    try {
      chmodSync(directory, 0o700);
      const filename = saveSnapshot(directory, snapshot);
      expect(statSync(filename).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(filename, "utf8"))).toEqual(snapshot);
      expect(() => saveSnapshot(directory, snapshot)).toThrow();
      chmodSync(directory, 0o755);
      expect(() => saveSnapshot(directory, { ...snapshot, capturedAt: "2026-09-15T20:00:00.000Z" })).toThrow("privado");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
