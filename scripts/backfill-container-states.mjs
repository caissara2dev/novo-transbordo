import { applicationDefault, deleteApp, initializeApp } from "firebase-admin/app";
import { FieldPath, getFirestore } from "firebase-admin/firestore";

const ALLOWED_PROJECTS = new Set([
  "line-transbordo-staging-382612",
  "line-transbordo"
]);
const PAGE_SIZE = 300;
const WRITE_BATCH_SIZE = 400;

function parseArgs(argv) {
  const projectArg = argv.find((arg) => arg.startsWith("--project="));
  const confirmArg = argv.find((arg) => arg.startsWith("--confirm-project="));
  const execute = argv.includes("--execute");

  return {
    help: argv.includes("--help"),
    execute,
    projectId: projectArg?.slice("--project=".length) || "",
    confirmation: confirmArg?.slice("--confirm-project=".length) || ""
  };
}

function validate(options) {
  if (!ALLOWED_PROJECTS.has(options.projectId)) {
    throw new Error("Projeto recusado. Informe staging ou produção explicitamente.");
  }
  if (options.execute && options.confirmation !== options.projectId) {
    throw new Error(
      `Para executar, informe --confirm-project=${options.projectId}.`
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
  const latest = new Map();
  let inspected = 0;
  let eligible = 0;

  for await (const doc of readEvents(db)) {
    inspected += 1;
    const data = doc.data();
    const status = statusFromEvent(data);
    if (
      data.deleted ||
      !status ||
      !data.container ||
      !data.clientId ||
      !data.plate
    ) {
      continue;
    }

    eligible += 1;
    const key = containerKey(data.container);
    const candidate = { id: doc.id, data, status, key };
    const current = latest.get(key);
    if (!current || isNewer(data, current.data)) latest.set(key, candidate);
  }

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
    batch.set(ref, {
      container: data.container,
      status: item.status,
      reason: data.containerReason || null,
      cycleId: data.containerCycleId || `legacy-${item.key}`,
      latestEventId: item.id,
      previousEventId: data.previousContainerEventId || null,
      clientId: data.clientId,
      clientNameSnapshot: data.clientNameSnapshot || null,
      plate: data.plate,
      pump: data.pump,
      operationalAt: data.endAt,
      eventCreatedAt: data.createdAt,
      version: Number(existing.data()?.version || 1),
      updatedAt: data.updatedAt || data.createdAt
    });
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
  npm run backfill:container-states -- --project=line-transbordo --execute --confirm-project=line-transbordo

O script nunca altera events; materializa somente containerStates.`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  validate(options);

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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
