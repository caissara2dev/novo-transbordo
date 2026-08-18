import { applicationDefault, deleteApp, initializeApp } from "firebase-admin/app";
import { FieldPath, getFirestore } from "firebase-admin/firestore";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ALLOWED_PROJECTS = new Set([
  "line-transbordo-staging-382612",
  "line-transbordo"
]);
export const PRODUCTION_BACKFILL_CONFIRMATION =
  "BACKFILL_CONTAINER_STATES_IN_PRODUCTION";
const PAGE_SIZE = 300;
const WRITE_BATCH_SIZE = 400;

function argumentValue(argv, name) {
  return argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) || null;
}

export function parseArgs(argv) {
  const knownFlags = new Set([
    "--help",
    "--dry-run",
    "--execute",
    "--allow-production"
  ]);
  const knownValuePrefixes = [
    "--project=",
    "--confirm-project=",
    "--confirm-production="
  ];
  const unknown = argv.find(
    (arg) =>
      arg.startsWith("--") &&
      !knownFlags.has(arg) &&
      !knownValuePrefixes.some((prefix) => arg.startsWith(prefix))
  );
  if (unknown) {
    throw new Error(`Argumento desconhecido: ${unknown}.`);
  }
  if (argv.includes("--execute") && argv.includes("--dry-run")) {
    throw new Error("Use apenas --dry-run ou --execute, nunca ambos.");
  }

  const projectArg = argv.find((arg) => arg.startsWith("--project="));
  const execute = argv.includes("--execute");

  return {
    help: argv.includes("--help"),
    execute,
    dryRun: !execute,
    projectId: projectArg?.slice("--project=".length) || "",
    confirmation: argumentValue(argv, "--confirm-project"),
    allowProduction: argv.includes("--allow-production"),
    productionConfirmation: argumentValue(argv, "--confirm-production")
  };
}

export function validateBackfillRequest(options) {
  if (!ALLOWED_PROJECTS.has(options.projectId)) {
    throw new Error("Projeto recusado. Informe staging ou produção explicitamente.");
  }
  if (options.execute && options.confirmation !== options.projectId) {
    throw new Error(
      `Para executar, informe --confirm-project=${options.projectId}.`
    );
  }
  if (!options.execute || options.projectId !== "line-transbordo") {
    return;
  }
  if (!options.allowProduction) {
    throw new Error(
      "Produção bloqueada. Acrescente --allow-production se esta ação for intencional."
    );
  }
  if (options.productionConfirmation !== PRODUCTION_BACKFILL_CONFIRMATION) {
    throw new Error(
      `Produção exige --confirm-production=${PRODUCTION_BACKFILL_CONFIRMATION}.`
    );
  }
}

function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value === "string") return Date.parse(value) || 0;
  return 0;
}

function containerKey(container) {
  return String(container).replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

function statusFromEvent(data) {
  const allowed = new Set([
    "FULL",
    "PARTIAL",
    "BUFFER",
    "BLEND_FULL",
    "BLEND_PARTIAL"
  ]);
  if (allowed.has(data.containerStatus)) return data.containerStatus;
  return data.category === "PRODUTIVO" && data.container ? "FULL" : null;
}

function isNewer(candidate, current) {
  const endDelta = toMillis(candidate.endAt) - toMillis(current.endAt);
  if (endDelta !== 0) return endDelta > 0;
  return toMillis(candidate.createdAt) > toMillis(current.createdAt);
}

function projectionValue(value) {
  return value && typeof value.toMillis === "function"
    ? value.toMillis()
    : value;
}

function isExistingStateNewer(existing, data) {
  if (!existing) return false;

  const existingOperationalAt = toMillis(existing.operationalAt);
  const candidateOperationalAt = toMillis(data.endAt);
  if (!existingOperationalAt || !candidateOperationalAt) return false;

  const operationalDelta = existingOperationalAt - candidateOperationalAt;
  if (operationalDelta !== 0) return operationalDelta > 0;

  return toMillis(existing.eventCreatedAt) > toMillis(data.createdAt);
}

export function buildContainerStateBackfillPatch({
  existing,
  eventId,
  key,
  status,
  data
}) {
  if (isExistingStateNewer(existing, data)) {
    return null;
  }

  const projection = {
    container: data.container,
    status,
    reason: data.containerReason || null,
    cycleId: data.containerCycleId || `legacy-${key}`,
    latestEventId: eventId,
    previousEventId: data.previousContainerEventId || null,
    clientId: data.clientId,
    clientNameSnapshot: data.clientNameSnapshot || null,
    plate: data.plate || null,
    pump: data.pump,
    latestEventRole: data.latestEventRole || "DESTINATION",
    relatedContainer: data.relatedContainer || null,
    operationalAt: data.endAt,
    eventCreatedAt: data.createdAt,
    updatedAt: data.updatedAt || data.createdAt
  };
  const currentVersion = Math.max(1, Number(existing?.version) || 1);
  const changed = !existing || Object.entries(projection).some(
    ([field, value]) =>
      projectionValue(existing[field]) !== projectionValue(value)
  );

  return {
    ...projection,
    version: existing && changed ? currentVersion + 1 : currentVersion
  };
}

function compareBackfillEvents(left, right) {
  const endDelta = toMillis(left.data.endAt) - toMillis(right.data.endAt);
  if (endDelta !== 0) return endDelta;
  const createdDelta = toMillis(left.data.createdAt) - toMillis(right.data.createdAt);
  if (createdDelta !== 0) return createdDelta;
  return left.id.localeCompare(right.id);
}

function updateLatestCandidate(latest, candidate) {
  const current = latest.get(candidate.key);
  if (!current || isNewer(candidate.data, current.data)) {
    latest.set(candidate.key, candidate);
  }
}

export function buildContainerStateBackfillCandidates(events) {
  const latest = new Map();
  const ordered = [...events]
    .filter(({ data }) => !data.deleted)
    .sort(compareBackfillEvents);

  for (const event of ordered) {
    const { id, data } = event;
    const destinationStatus = statusFromEvent(data);
    if (destinationStatus && data.container && data.clientId) {
      const key = containerKey(data.container);
      updateLatestCandidate(latest, {
        id,
        key,
        status: destinationStatus,
        data: {
          ...data,
          plate: data.plate || null,
          latestEventRole: "DESTINATION",
          relatedContainer:
            data.loadSourceType === "BUFFER_CONTAINER"
              ? data.sourceContainer || null
              : null
        }
      });
    }

    if (
      destinationStatus &&
      data.loadSourceType === "BUFFER_CONTAINER" &&
      data.sourceContainer &&
      data.clientId &&
      typeof data.sourceContainerEmptied === "boolean"
    ) {
      const key = containerKey(data.sourceContainer);
      const previous = latest.get(key)?.data;
      const status = data.sourceContainerEmptied
        ? "TRANSFER_EMPTIED"
        : "BUFFER";
      updateLatestCandidate(latest, {
        id,
        key,
        status,
        data: {
          ...data,
          container: data.sourceContainer,
          containerStatus: status,
          containerReason: previous?.containerReason || null,
          containerCycleId:
            data.sourceContainerCycleId ||
            previous?.containerCycleId ||
            `legacy-${key}`,
          previousContainerEventId:
            data.previousSourceContainerEventId || null,
          plate: previous?.plate || null,
          latestEventRole: "SOURCE",
          relatedContainer: data.container
        }
      });
    }
  }

  return latest;
}

async function* readEvents(db) {
  let cursor = null;
  while (true) {
    let query = db.collection("events").orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);
    const snap = await query.get();
    if (snap.empty) return;
    for (const doc of snap.docs) yield doc;
    cursor = snap.docs.at(-1);
    if (snap.size < PAGE_SIZE) return;
  }
}

async function buildLatestStates(db) {
  const events = [];
  let inspected = 0;
  let eligible = 0;

  for await (const doc of readEvents(db)) {
    inspected += 1;
    const data = doc.data();
    if (data.deleted || !statusFromEvent(data) || !data.container || !data.clientId) {
      continue;
    }

    eligible += 1;
    events.push({ id: doc.id, data });
  }

  const latest = buildContainerStateBackfillCandidates(events);
  return { inspected, eligible, latest };
}

async function writeStates(db, latest) {
  let batch = db.batch();
  let writes = 0;
  let pending = 0;

  const flush = async () => {
    if (!pending) return;
    await batch.commit();
    batch = db.batch();
    pending = 0;
  };

  for (const item of latest.values()) {
    const ref = db.collection("containerStates").doc(item.key);
    const existing = await ref.get();
    const data = item.data;
    const patch = buildContainerStateBackfillPatch({
      existing: existing.data(),
      eventId: item.id,
      key: item.key,
      status: item.status,
      data
    });
    if (!patch) {
      continue;
    }
    batch.set(
      ref,
      patch
    );
    writes += 1;
    pending += 1;
    if (pending >= WRITE_BATCH_SIZE) await flush();
  }

  await flush();
  return writes;
}

function printHelp() {
  console.log(`Uso:
  npm run backfill:container-states -- --project=line-transbordo-staging-382612 --dry-run
  npm run backfill:container-states -- --project=line-transbordo-staging-382612 --execute --confirm-project=line-transbordo-staging-382612
  npm run backfill:container-states -- --project=line-transbordo --execute --confirm-project=line-transbordo \
    --allow-production --confirm-production=${PRODUCTION_BACKFILL_CONFIRMATION}

O script nunca altera events; materializa somente containerStates.`);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }
  validateBackfillRequest(options);

  const app = initializeApp(
    { credential: applicationDefault(), projectId: options.projectId },
    `container-backfill-${options.projectId}`
  );

  try {
    const db = getFirestore(app);
    const result = await buildLatestStates(db);
    console.log(
      JSON.stringify(
        {
          mode: options.execute ? "execute" : "dry-run",
          projectId: options.projectId,
          inspectedEvents: result.inspected,
          eligibleEvents: result.eligible,
          containerStates: result.latest.size
        },
        null,
        2
      )
    );

    if (!options.execute) {
      console.log("Simulação concluída. Nenhum documento foi alterado.");
      return;
    }

    const writes = await writeStates(db, result.latest);
    const finalCount = (await db.collection("containerStates").count().get()).data().count;
    if (finalCount < result.latest.size) {
      throw new Error("Verificação final encontrou menos estados que o esperado.");
    }
    console.log(JSON.stringify({ writes, finalCount }, null, 2));
  } finally {
    await deleteApp(app);
  }
}

const isDirectInvocation =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectInvocation) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
