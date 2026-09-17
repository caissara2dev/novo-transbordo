/* eslint-disable @typescript-eslint/no-require-imports -- Firebase CLI administrative SDK is CommonJS. */
const fs = require('node:fs');
const path = require('node:path');
const {isDeepStrictEqual} = require('node:util');

const TARGET = Object.freeze({
  project: 'line-transbordo-staging-382612',
  region: 'us-central1',
  service: 'checkin-document-worker'
});
const HOST = 'run.googleapis.com';
const RESOURCE = `projects/${TARGET.project}/locations/${TARGET.region}/services/${TARGET.service}`;
const REVISION_PREFIX = `${RESOURCE}/revisions/${TARGET.service}-`;
const OPERATION_PREFIX = `projects/${TARGET.project}/locations/${TARGET.region}/operations/`;

function parseArgs(args) {
  const options = {...TARGET, apply: false, evidenceDir: null};
  const seen = new Set();
  for (const arg of args) {
    const [key, ...parts] = arg.split('=');
    if (seen.has(key)) throw new Error(`Argumento duplicado: ${key}`);
    seen.add(key);
    if (arg === '--apply') options.apply = true;
    else if (['--project', '--region', '--service', '--evidence-dir'].includes(key) && parts.join('=')) {
      options[key === '--evidence-dir' ? 'evidenceDir' : key.slice(2)] = parts.join('=');
    } else throw new Error(`Argumento desconhecido ou incompleto: ${key}`);
  }
  validateTarget(options);
  if (options.apply && !options.evidenceDir) throw new Error('--apply exige --evidence-dir=<diretório privado>.');
  return options;
}

function validateTarget(options) {
  for (const key of Object.keys(TARGET)) {
    if (options[key] !== TARGET[key]) throw new Error(`Destino recusado: ${key} deve ser ${TARGET[key]}.`);
  }
}

function assertService(service) {
  if (!service || service.name !== RESOURCE) throw new Error('Serviço ausente ou fora do destino permitido.');
  if (!service.etag || service.reconciling || service.deleteTime ||
      service.terminalCondition?.state !== 'CONDITION_SUCCEEDED' ||
      !service.latestReadyRevision?.startsWith(REVISION_PREFIX) ||
      service.latestCreatedRevision !== service.latestReadyRevision) {
    throw new Error('Serviço não está estável/pronto ou está sem etag; nenhuma atualização permitida.');
  }
  const template = service.template;
  if (template?.containers?.length !== 1 ||
      template.serviceAccount !== `${TARGET.service}@${TARGET.project}.iam.gserviceaccount.com` ||
      template.maxInstanceRequestConcurrency !== 1 || template.timeout !== '240s' ||
      (template.scaling?.minInstanceCount ?? 0) !== 0 || template.scaling?.maxInstanceCount !== 1 ||
      (service.scaling?.minInstanceCount ?? 0) !== 0 ||
      (service.scaling?.scalingMode && service.scaling.scalingMode !== 'AUTOMATIC')) {
    throw new Error('Configuração inesperada de container, identidade ou escala; revisar antes de atualizar.');
  }
  const container = template.containers[0];
  if (Number(container.resources?.limits?.cpu) !== 1 || container.resources?.limits?.memory !== '1Gi' ||
      !container.image?.startsWith(`${TARGET.region}-docker.pkg.dev/${TARGET.project}/checkin-nf/`) ||
      (container.resources.cpuIdle !== undefined && typeof container.resources.cpuIdle !== 'boolean')) {
    throw new Error('Imagem ou recursos inesperados; nenhuma atualização permitida.');
  }
  const traffic = service.trafficStatuses;
  if (traffic?.length !== 1 || traffic[0].type !== 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST' ||
      traffic[0].percent !== 100 || (traffic[0].revision && traffic[0].revision !== service.latestReadyRevision &&
        traffic[0].revision !== service.latestReadyRevision.split('/').at(-1))) {
    throw new Error('Tráfego não está integralmente na revisão pronta; revisar antes de atualizar.');
  }
}

function imageDigest(revision, revisionName) {
  if (revision?.name !== revisionName || revision.containers?.length !== 1 ||
      revision.conditions?.find((condition) => condition.type === 'Ready')?.state !== 'CONDITION_SUCCEEDED') {
    throw new Error('Revisão inválida ou não pronta.');
  }
  const image = revision.containers[0].image;
  const digest = image?.match(/@sha256:([a-f0-9]{64})$/)?.[1];
  if (!digest) throw new Error('A revisão não informou digest SHA-256 imutável da imagem.');
  return digest;
}

function planUpdate(service) {
  assertService(service);
  if (service.template.containers[0].resources.cpuIdle === true) return null;
  const containers = structuredClone(service.template.containers);
  containers[0].resources.cpuIdle = true;
  return {name: RESOURCE, etag: service.etag, template: {containers}};
}

function saveSnapshot(directory, snapshot) {
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) {
    throw new Error('O diretório de evidências deve ser privado (permissão 0700) e não pode ser link.');
  }
  const filename = path.join(directory, `worker-billing-before-${snapshot.capturedAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(filename, JSON.stringify(snapshot, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
  return filename;
}

async function waitOperation(operation, request, {sleep, now, timeoutMs}) {
  const deadline = now() + timeoutMs;
  while (!operation.done) {
    if (!operation.name?.startsWith(OPERATION_PREFIX)) throw new Error('Operação fora do destino permitido.');
    if (now() >= deadline) throw new Error('Tempo limite da operação; consultar serviço antes de repetir ou reverter.');
    await sleep(5000);
    operation = await request(HOST, '/v2/' + operation.name);
  }
  if (operation.error) throw new Error(`Cloud Run recusou a operação (código ${operation.error.code}).`);
}

function validatePreview(operation, patch) {
  if (operation.error) throw new Error(`Cloud Run recusou a validação (código ${operation.error.code}).`);
  // validateOnly does not persist resources, including this synthetic operation.
  // Cloud Run returns the defaulted Service inline as metadata, often still pending;
  // polling its name would return 404. Inspect the proposed containers instead.
  const service = operation.metadata || operation.response;
  if (!operation.name?.startsWith(OPERATION_PREFIX) ||
      service?.['@type'] !== 'type.googleapis.com/google.cloud.run.v2.Service' ||
      service.name !== RESOURCE || !isDeepStrictEqual(service.template?.containers, patch.template.containers)) {
    throw new Error('Resposta de validateOnly inesperada; aplicação recusada.');
  }
}

async function run(options, dependencies) {
  validateTarget(options);
  if (options.apply && !options.evidenceDir) throw new Error('--apply exige --evidence-dir=<diretório privado>.');
  const {request} = dependencies;
  const now = dependencies.now || Date.now;
  const polling = {
    now, sleep: dependencies.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    timeoutMs: dependencies.timeoutMs || 300000
  };
  const service = await request(HOST, '/v2/' + RESOURCE);
  const patch = planUpdate(service);
  const revision = await request(HOST, '/v2/' + service.latestReadyRevision);
  const digest = imageDigest(revision, service.latestReadyRevision);
  const summary = {service: RESOURCE, mode: options.apply ? 'apply' : 'dry-run', digest, beforeRevision: service.latestReadyRevision};
  if (!patch) {
    if (revision.containers[0].resources?.cpuIdle !== true) throw new Error('CPU da revisão não corresponde ao serviço.');
    return {...summary, status: 'already-correct', revision: service.latestReadyRevision};
  }

  // Only containers enter the update mask; IAM, traffic, scale, image and scheduling are untouched.
  const patchPath = '/v2/' + RESOURCE + '?updateMask=template.containers';
  let snapshotPath;
  if (options.apply) {
    snapshotPath = (dependencies.saveSnapshot || saveSnapshot)(options.evidenceDir, {
      capturedAt: new Date(now()).toISOString(), service, revision, digest,
      intendedPatch: patch, updateMask: 'template.containers'
    });
  }
  const validation = await request(HOST, patchPath + '&validateOnly=true', 'PATCH', patch);
  validatePreview(validation, patch);
  if (!options.apply) return {...summary, status: 'validated', change: {cpuIdle: {before: service.template.containers[0].resources.cpuIdle ?? false, after: true}}};

  const current = await request(HOST, '/v2/' + RESOURCE);
  assertService(current);
  if (current.etag !== service.etag || !isDeepStrictEqual(current.template, service.template) ||
      !isDeepStrictEqual(current.traffic, service.traffic)) {
    throw new Error(`Configuração mudou durante a validação; aplicação recusada. Snapshot: ${snapshotPath}`);
  }
  // A race after this GET is rejected by Cloud Run through this same etag; never retry a PATCH blindly.
  const operation = await request(HOST, patchPath, 'PATCH', patch);
  await waitOperation(operation, request, polling);
  const after = await request(HOST, '/v2/' + RESOURCE);
  assertService(after);
  const nextRevision = await request(HOST, '/v2/' + after.latestReadyRevision);
  if (imageDigest(nextRevision, after.latestReadyRevision) !== digest ||
      after.template.containers[0].resources.cpuIdle !== true || nextRevision.containers[0].resources?.cpuIdle !== true) {
    throw new Error(`Verificação final falhou; consultar snapshot antes de reverter: ${snapshotPath}`);
  }
  const expectedTemplate = structuredClone(service.template);
  expectedTemplate.containers = patch.template.containers;
  // The API may replace an explicit revision name with the new generated revision.
  delete expectedTemplate.revision;
  const actualTemplate = structuredClone(after.template);
  delete actualTemplate.revision;
  if (!isDeepStrictEqual(actualTemplate, expectedTemplate) || !isDeepStrictEqual(after.traffic, service.traffic)) {
    throw new Error(`Configuração além de cpuIdle mudou; revisar snapshot: ${snapshotPath}`);
  }
  return {...summary, status: 'updated', revision: after.latestReadyRevision, snapshotPath};
}

module.exports = {TARGET, RESOURCE, parseArgs, planUpdate, imageDigest, run, saveSnapshot, waitOperation};

if (require.main === module) {
  Promise.resolve().then(() => {
    const options = parseArgs(process.argv.slice(2));
    const {request} = require('./cloud.cjs');
    return run(options, {request});
  }).then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
