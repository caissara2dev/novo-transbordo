import {
  containersAffectedBy,
  eventContainerStatus,
  planEffectsForContainer,
  projectionFromPlan
} from "../src/lib/domain/container-effects.ts";
import {
  applicationDefault,
  deleteApp,
  initializeApp
} from "firebase-admin/app";
import { FieldPath, FieldValue, getFirestore } from "firebase-admin/firestore";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ALLOWED_PROJECTS = new Set([
  "line-transbordo-staging-382612",
  "line-transbordo"
]);
export const PRODUCTION_BACKFILL_CONFIRMATION =
  "BACKFILL_CONTAINER_STATES_IN_PRODUCTION";
const PAGE_SIZE = 300;

function argumentValue(argv, name) {
  return (
    argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ||
    null
  );
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
    throw new Error(
      "Projeto recusado. Informe staging ou produção explicitamente."
    );
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
  return String(container)
    .replace(/[^A-Z0-9]/gi, "")
    .toUpperCase();
}

const statusFromEvent = eventContainerStatus;

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
    eventCreatedAt: data.createdAt
  };
  const currentVersion = Math.max(1, Number(existing?.version) || 1);
  const changed =
    !existing ||
    Object.entries(projection).some(
      ([field, value]) =>
        projectionValue(existing[field]) !== projectionValue(value)
    );

  return {
    ...projection,
    updatedAt: changed ? data.updatedAt || data.createdAt : existing.updatedAt,
    version: existing && changed ? currentVersion + 1 : currentVersion
  };
}

export function buildContainerStateBackfillCandidates(events) {
  const grouped = new Map();
  for (const event of events) {
    if (event.data.deleted) continue;
    for (const container of containersAffectedBy(event.data)) {
      const records = grouped.get(container) || [];
      records.push(event);
      grouped.set(container, records);
    }
  }
  const latest = new Map();
  for (const [container, records] of grouped) {
    const candidate = buildCandidate(container, records);
    if (candidate) latest.set(candidate.key, candidate);
  }
  return latest;
}

function buildCandidate(container, records) {
  const key = containerKey(container);
  let cycle = 0;
  const { effects, plan } = planEffectsForContainer(
    container,
    records,
    () => `legacy-${key}-${++cycle}`
  );
  const current = effects.find((effect) => effect.id === plan.current?.id);
  if (!current) return null;
  const projection = projectionFromPlan({
    effects,
    links: plan.events,
    current,
    version: 0
  });
  return {
    id: current.id,
    key,
    status: projection.status,
    data: {
      ...current.data,
      container: projection.container,
      containerStatus: projection.status,
      containerReason: projection.reason,
      containerCycleId: projection.cycleId,
      previousContainerEventId: projection.previousEventId,
      plate: projection.plate,
      latestEventRole: projection.latestEventRole,
      relatedContainer: projection.relatedContainer
    }
  };
}
async function* readEvents(db) {
  let cursor = null;
  while (true) {
    let query = db
      .collection("events")
      .orderBy(FieldPath.documentId())
      .limit(PAGE_SIZE);
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
    if (
      data.deleted ||
      !statusFromEvent(data) ||
      !data.container ||
      !data.clientId
    ) {
      continue;
    }

    eligible += 1;
    events.push({ id: doc.id, data });
  }

  const latest = buildContainerStateBackfillCandidates(events);
  return { inspected, eligible, latest };
}

export async function writeStates(db, latest) {
  let writes = 0;
  let skipped = 0;
  for (const item of latest.values()) {
    // The scan selects work only. Read both event roles and the projection
    // again in one transaction, so a concurrent edit cannot be overwritten.
    const written = await db.runTransaction(async (transaction) => {
      const ref = db.collection("containerStates").doc(item.key);
      const [existing, destination, source] = await Promise.all([
        transaction.get(ref),
        transaction.get(
          db.collection("events").where("container", "==", item.data.container)
        ),
        transaction.get(
          db
            .collection("events")
            .where("sourceContainer", "==", item.data.container)
        )
      ]);
      const records = Array.from(
        new Map(
          [...destination.docs, ...source.docs].map((doc) => [
            doc.id,
            { id: doc.id, data: doc.data() }
          ])
        ).values()
      );
      const current = buildCandidate(
        item.data.container,
        records.filter((record) => !record.data.deleted)
      );
      if (!current) return false;
      const patch = buildContainerStateBackfillPatch({
        existing: existing.data(),
        eventId: current.id,
        key: current.key,
        status: current.status,
        data: current.data
      });
      if (
        !patch ||
        (existing.exists && patch.version === existing.data().version)
      ) {
        return false;
      }
      transaction.set(ref, {
        ...patch,
        updatedAt: FieldValue.serverTimestamp()
      });
      return true;
    });
    if (written) writes += 1;
    else skipped += 1;
  }
  return { writes, skipped };
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

    const outcome = await writeStates(db, result.latest);
    const finalCount = (
      await db.collection("containerStates").count().get()
    ).data().count;
    console.log(JSON.stringify({ ...outcome, finalCount }, null, 2));
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
