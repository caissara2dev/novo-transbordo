import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
const require = createRequire(import.meta.url);
const { run, parseArgs, inferClosure } = require("../../scripts/homologation/backfill-document-closure.cjs");
type Commit = { transaction: string; writes: { update: { fields: Record<string, unknown> }; currentDocument?: Record<string, unknown> }[] };
const project = "line-transbordo-staging-382612";
const visitName = `projects/${project}/databases/(default)/documents/checkins/11111111-1111-4111-8111-111111111111`;
const evidence = {
  id: "closing", before: {status: "EM_DESCARGA"}, after: {status: "CONCLUIDO"},
  changedFields: ["status"], previousVersion: 4, newVersion: 5, createdAtIso: "2024-02-29T09:10:11.012Z",
};
function value(input: unknown): unknown {
  if (typeof input === "string") return {stringValue: input};
  if (typeof input === "number") return {integerValue: String(input)};
  if (Array.isArray(input)) return {arrayValue: {values: input.map(value)}};
  return {mapValue: {fields: Object.fromEntries(Object.entries(input as object).map(([key, item]) => [key, value(item)]))}};
}
const doc = (name: string, data: Record<string, unknown>) => ({name, updateTime: "2026-01-01T00:00:00.000Z", fields: (value(data) as {mapValue: {fields: unknown}}).mapValue.fields});
function transport({conflict = false, evidenceAvailable = true, currentDocument = false} = {}) {
  const calls: {path: string; body: Record<string, unknown> | undefined}[] = [];
  const request = async (_host: string, path: string, _method: string, body: Record<string, unknown> | undefined) => {
    calls.push({path, body});
    if (path.endsWith(":beginTransaction")) return {transaction: "fake-transaction"};
    if (path.includes("?transaction=")) return doc(visitName, {status: "CONCLUIDO", version: 8, ...(currentDocument ? {document: {current: {id: "fake-document"}}} : {})});
    if (path === `/v1/${visitName}:runQuery`) return evidenceAvailable ? [{document: doc(`${visitName}/revisions/closing`, evidence)}] : [];
    if (path.endsWith(":runQuery")) return [{document: doc(visitName, {status: "CONCLUIDO", version: 8, ...(currentDocument ? {document: {current: {id: "fake-document"}}} : {})})}];
    if (path.endsWith(":commit") && conflict) throw new Error("Concurrent write");
    if (path.endsWith(":commit") || path.endsWith(":rollback")) return {};
    throw new Error(`Unexpected request ${path}`);
  };
  return {request, calls};
}
describe("document closure backfill", () => {
  it("defaults to simulation and never begins a write transaction", async () => {
    const fake = transport();
    const result = await run(parseArgs([]), fake.request);
    expect(result).toMatchObject({mode: "dry-run", examined: 1, backfill: 1, changed: 0});
    expect(fake.calls.every(item => item.path.endsWith(":runQuery"))).toBe(true);
  });
  it("reports current notes that would become eligible before any writes", async () => {
    const fake = transport({currentDocument: true});
    expect(await run(parseArgs([]), fake.request)).toMatchObject({eligibleForExpiration: 1, changed: 0});
    expect(fake.calls.every(item => item.path.endsWith(":runQuery"))).toBe(true);
  });
  it("applies proven dates with a version precondition and one audit in the transaction", async () => {
    const fake = transport();
    expect(await run(parseArgs(["--apply"]), fake.request)).toMatchObject({changed: 1});
    const commit = fake.calls.find(item => item.path.endsWith(":commit"))!.body! as unknown as Commit;
    expect(commit.transaction).toBe("fake-transaction");
    expect(commit.writes).toHaveLength(2);
    expect(commit.writes[0]).toMatchObject({currentDocument: {updateTime: "2026-01-01T00:00:00.000Z"}, update: {fields: {
      closedAtIso: {stringValue: evidence.createdAtIso}, documentExpiresAtIso: {stringValue: "2025-02-28T09:10:11.012Z"},
      documentRetentionReviewRequired: {booleanValue: false}, version: {integerValue: "9"},
    }}});
  });
  it("only flags uncertain records, preserving absent deadline", async () => {
    const fake = transport({evidenceAvailable: false});
    expect(await run(parseArgs(["--apply"]), fake.request)).toMatchObject({review: 1, changed: 1});
    const commit = fake.calls.find(item => item.path.endsWith(":commit"))!.body! as unknown as Commit;
    expect(commit.writes[0].update.fields.documentRetentionReviewRequired).toEqual({booleanValue: true});
    expect(commit.writes[0].update.fields.documentExpiresAtIso).toBeUndefined();
  });
  it("rolls back on concurrent modification without retrying a stale plan", async () => {
    const fake = transport({conflict: true});
    await expect(run(parseArgs(["--apply"]), fake.request)).rejects.toThrow("Concurrent write");
    expect(fake.calls.at(-1)?.path).toMatch(/:rollback$/);
  });
  it("rejects production and unsupported flags before network access", () => {
    expect(() => parseArgs(["--project=line-transbordo", "--apply"])).toThrow();
    expect(() => parseArgs(["--allow-production"])).toThrow();
  });
  it("does not infer a closure from a later edit timestamp", () => {
    expect(inferClosure({status: "CANCELADO", version: 10, updatedAtIso: "2026-09-17T00:00:00.000Z"}, [])).toMatchObject({kind: "review"});
  });
});
