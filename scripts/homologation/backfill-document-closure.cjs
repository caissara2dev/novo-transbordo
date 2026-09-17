/* eslint-disable @typescript-eslint/no-require-imports -- Administrative Firebase CLI helper. */
/** Staging-only closure backfill. Dry-run by default; no storage objects are touched. */
const PROJECT = 'line-transbordo-staging-382612';
const CLOSED = new Set(['CONCLUIDO', 'CANCELADO']);
const CANONICAL_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function validIso(value) {
  return typeof value === 'string' && CANONICAL_ISO.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function deadline(closedAt) {
  if (!validIso(closedAt)) return null;
  const value = new Date(closedAt), year = value.getUTCFullYear() + 1, month = value.getUTCMonth();
  value.setUTCDate(Math.min(value.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate()));
  value.setUTCFullYear(year);
  return value.toISOString();
}
function inferClosure(visit, revisions, complete = true) {
  if (!CLOSED.has(visit.status)) return {kind: 'skip', reason: 'Visit is not closed'};
  if (validIso(visit.closedAtIso) && deadline(visit.closedAtIso) === visit.documentExpiresAtIso && visit.documentRetentionReviewRequired === false)
    return {kind: 'skip', reason: 'Retention dates already configured'};
  if (visit.closedAtIso || visit.documentExpiresAtIso)
    return {kind: 'review', reason: 'Existing retention dates require review'};
  if (!complete || !Number.isInteger(visit.version)) return {kind: 'review', reason: 'Closure history is incomplete'};
  const changes = revisions.filter(item => (item.changedFields || []).includes('status') || item.before?.status || item.after?.status || item.action === 'PRE_REGISTRATION_EXPIRED');
  const candidates = changes.filter(item => {
    const explicit = item.after?.status === visit.status && typeof item.before?.status === 'string' && !CLOSED.has(item.before.status);
    const expired = item.action === 'PRE_REGISTRATION_EXPIRED' && item.reason === 'EXPIRADO' && visit.status === 'CANCELADO';
    return (explicit || expired) && validIso(item.createdAtIso) && Number.isInteger(item.previousVersion)
      && item.newVersion === item.previousVersion + 1 && item.newVersion <= visit.version;
  });
  if (candidates.length !== 1) return {kind: 'review', reason: 'A unique terminal transition was not proved'};
  const evidence = candidates[0];
  if (changes.some(item => item !== evidence && (!Number.isInteger(item.newVersion) || item.newVersion >= evidence.newVersion)))
    return {kind: 'review', reason: 'A later or ambiguous status change exists'};
  return {kind: 'backfill', closedAtIso: evidence.createdAtIso, documentExpiresAtIso: deadline(evidence.createdAtIso), evidenceId: evidence.id};
}
function parseArgs(argv) {
  const allowed = ['--apply', '--dry-run', '--self-test'];
  if (argv.some(arg => !allowed.includes(arg) && !arg.startsWith('--project=') && !arg.startsWith('--limit=') && !arg.startsWith('--start-after='))) throw new Error('Unknown argument');
  if (argv.includes('--apply') && argv.includes('--dry-run')) throw new Error('Choose only apply or dry-run');
  const project = argv.find(arg => arg.startsWith('--project='))?.slice(10) || PROJECT;
  if (project !== PROJECT) throw new Error('Only staging is permitted');
  const limit = Number(argv.find(arg => arg.startsWith('--limit='))?.slice(8) || 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Limit must be 1..500');
  const startAfter = argv.find(arg => arg.startsWith('--start-after='))?.slice(14);
  if (startAfter && !/^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/.test(startAfter)) throw new Error('Invalid visit cursor');
  return {project, limit, startAfter, apply: argv.includes('--apply')};
}
function decode(value) {
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('nullValue' in value) return null;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decode);
  if ('mapValue' in value) return Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([key, v]) => [key, decode(v)]));
  return undefined;
}
function documentValue(doc) { return Object.fromEntries(Object.entries(doc.fields || {}).map(([key, value]) => [key, decode(value)])); }
function encode(value) {
  if (value === null) return {nullValue: null};
  if (typeof value === 'string') return {stringValue: value};
  if (typeof value === 'boolean') return {booleanValue: value};
  if (typeof value === 'number') return {integerValue: String(value)};
  if (Array.isArray(value)) return {arrayValue: {values: value.map(encode)}};
  return {mapValue: {fields: fields(value)}};
}
function fields(value) { return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)])); }
async function run(options, request) {
  const host = 'firestore.googleapis.com', base = `/v1/projects/${PROJECT}/databases/(default)/documents`;
  const result = {project: PROJECT, mode: options.apply ? 'apply' : 'dry-run', examined: 0, backfill: 0, review: 0, skipped: 0, changed: 0, eligibleForExpiration: 0, nextCursor: null};
  const query = {from: [{collectionId: 'checkins'}], where: {fieldFilter: {field: {fieldPath: 'status'}, op: 'IN', value: encode([...CLOSED])}}, orderBy: [{field: {fieldPath: '__name__'}, direction: 'ASCENDING'}], limit: options.limit,
    ...(options.startAfter ? {startAt: {values: [{referenceValue: `projects/${PROJECT}/databases/(default)/documents/checkins/${options.startAfter}`}], before: false}} : {})};
  const rows = await request(host, `${base}:runQuery`, 'POST', {structuredQuery: query});
  const documents = rows.filter(item => item.document);
  result.nextCursor = documents.length === options.limit ? documents.at(-1).document.name.split('/').at(-1) : null;
  for (const row of documents) {
    let transaction;
    try {
      if (options.apply) transaction = (await request(host, `${base}:beginTransaction`, 'POST', {options: {readWrite: {}}})).transaction;
      const doc = transaction ? await request(host, `/v1/${row.document.name}?transaction=${encodeURIComponent(transaction)}`) : row.document;
      const visit = documentValue(doc), name = doc.name;
      const history = await request(host, `/v1/${name}:runQuery`, 'POST', {
        structuredQuery: {from: [{collectionId: 'revisions'}], limit: 1001}, ...(transaction ? {transaction} : {}),
      });
      const revisions = history.filter(item => item.document).map(item => ({...documentValue(item.document), id: item.document.name.split('/').at(-1)}));
      const plan = inferClosure(visit, revisions, revisions.length <= 1000);
      result.examined++;
      result[plan.kind === 'skip' ? 'skipped' : plan.kind]++;
      if (plan.kind === 'backfill' && visit.document?.current && Date.parse(plan.documentExpiresAtIso) <= Date.now()) result.eligibleForExpiration++;
      const patch = plan.kind === 'backfill'
        ? {closedAtIso: plan.closedAtIso, documentExpiresAtIso: plan.documentExpiresAtIso, documentRetentionReviewRequired: false}
        : plan.kind === 'review' && visit.documentRetentionReviewRequired !== true ? {documentRetentionReviewRequired: true} : null;
      if (transaction && patch) {
        const timestamp = new Date().toISOString(), version = Number.isInteger(visit.version) ? visit.version + 1 : null;
        if (version === null) throw new Error('Invalid visit version; manual review required');
        const metadata = {...patch, version, updatedAtIso: timestamp, updatedBy: 'Sistema Line'};
        const suffix = require('node:crypto').createHash('sha256').update(JSON.stringify(patch)).digest('hex').slice(0, 20);
        const audit = {action: plan.kind === 'backfill' ? 'Prazo documental recuperado do histórico' : 'Prazo documental requer conferência',
          actor: 'Sistema Line', actorUid: 'document-closure-backfill', actorRole: 'SYSTEM', createdAtIso: timestamp,
          changedFields: Object.keys(patch), previousVersion: visit.version, newVersion: version, reason: plan.reason || 'Explicit closure revision',
          ...(plan.evidenceId ? {closureRevisionId: plan.evidenceId} : {})};
        await request(host, `${base}:commit`, 'POST', {transaction, writes: [
          {update: {name, fields: fields(metadata)}, updateMask: {fieldPaths: Object.keys(metadata)}, currentDocument: {updateTime: doc.updateTime}},
          {update: {name: `${name}/revisions/retention-backfill-${suffix}`, fields: fields(audit)}, currentDocument: {exists: false}},
        ]});
        transaction = null;
        result.changed++;
      }
    } finally {
      if (transaction) await request(host, `${base}:rollback`, 'POST', {transaction});
    }
  }
  return result;
}
function selfTest() {
  const assert = require('node:assert/strict');
  assert.equal(parseArgs([]).apply, false);
  assert.throws(() => parseArgs(['--project=line-transbordo', '--apply']));
  assert.throws(() => parseArgs(['--apply', '--dry-run']));
  assert.equal(deadline('2024-02-29T09:10:11.012Z'), '2025-02-28T09:10:11.012Z');
  const visit = {status: 'CONCLUIDO', version: 8, updatedAtIso: '2027-01-01T00:00:00.000Z'};
  const evidence = {id: 'closing', before: {status: 'EM_DESCARGA'}, after: {status: 'CONCLUIDO'}, changedFields: ['status'], previousVersion: 4, newVersion: 5, createdAtIso: '2024-02-29T09:10:11.012Z'};
  assert.equal(inferClosure(visit, [evidence]).closedAtIso, evidence.createdAtIso);
  assert.equal(inferClosure(visit, []).kind, 'review');
  assert.equal(inferClosure(visit, [evidence, {...evidence, id: 'other'}]).kind, 'review');
  assert.equal(inferClosure(visit, [evidence], false).kind, 'review');
  assert.equal(inferClosure(visit, [evidence, {changedFields: ['status'], newVersion: 6}]).kind, 'review');
  assert.equal(inferClosure({...visit, status: 'CHAMADO'}, [evidence]).kind, 'skip');
  assert.equal(inferClosure({...visit, closedAtIso: evidence.createdAtIso, documentExpiresAtIso: deadline(evidence.createdAtIso), documentRetentionReviewRequired: false}, []).kind, 'skip');
  assert.equal(inferClosure({...visit, closedAtIso: 'invalid'}, [evidence]).kind, 'review');
  console.log(JSON.stringify({passed: 12, networkUsed: false}));
}
module.exports = {inferClosure, deadline, parseArgs, run};
if (require.main === module) {
  if (process.argv.includes('--self-test')) selfTest();
  else Promise.resolve().then(() => run(parseArgs(process.argv.slice(2)), require('./cloud.cjs').request))
    .then(value => console.log(JSON.stringify(value))).catch(error => {console.error(error.message); process.exitCode = 1;});
}
