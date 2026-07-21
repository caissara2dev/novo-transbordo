import { applicationDefault, deleteApp, initializeApp } from "firebase-admin/app";
import { FieldPath, getFirestore } from "firebase-admin/firestore";

const EXPECTED_SOURCE_PROJECT = "line-transbordo";
const EXPECTED_TARGET_PROJECT = "line-transbordo-staging-382612";
const PAGE_SIZE = 200;
const WRITE_BATCH_SIZE = 400;

function parseArgs(argv) {
  const execute = argv.includes("--execute");
  const dryRun = argv.includes("--dry-run") || !execute;
  const confirmationArg = argv.find((arg) => arg.startsWith("--confirm-target="));

  if (argv.includes("--help")) {
    return { help: true, execute: false, dryRun: true, confirmation: null };
  }

  if (argv.includes("--execute") && argv.includes("--dry-run")) {
    throw new Error("Use apenas --dry-run ou --execute, nunca ambos.");
  }

  return {
    help: false,
    execute,
    dryRun,
    confirmation: confirmationArg?.slice("--confirm-target=".length) || null
  };
}

function validateProjects(sourceProject, targetProject, options) {
  if (sourceProject !== EXPECTED_SOURCE_PROJECT) {
    throw new Error(`Origem recusada: esperado ${EXPECTED_SOURCE_PROJECT}.`);
  }

  if (targetProject !== EXPECTED_TARGET_PROJECT) {
    throw new Error(`Destino recusado: esperado ${EXPECTED_TARGET_PROJECT}.`);
  }

  if (sourceProject === targetProject || targetProject === "line-transbordo") {
    throw new Error("Operação recusada: o destino não pode ser a produção.");
  }

  if (options.execute && options.confirmation !== EXPECTED_TARGET_PROJECT) {
    throw new Error(
      `Para executar, informe --confirm-target=${EXPECTED_TARGET_PROJECT}.`
    );
  }
}

async function* readCollection(collectionRef) {
  let cursor = null;

  while (true) {
    let query = collectionRef.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) {
      query = query.startAfter(cursor);
    }

    const snapshot = await query.get();
    if (snapshot.empty) {
      return;
    }

    for (const doc of snapshot.docs) {
      yield doc;
    }

    cursor = snapshot.docs.at(-1);
    if (snapshot.size < PAGE_SIZE) {
      return;
    }
  }
}

async function countCollection(collectionRef) {
  const result = await collectionRef.count().get();
  return result.data().count;
}

async function inspectSource(sourceDb) {
  const summary = { clients: 0, events: 0, revisions: 0 };

  for await (const client of readCollection(sourceDb.collection("clients"))) {
    void client;
    summary.clients += 1;
  }

  for await (const event of readCollection(sourceDb.collection("events"))) {
    summary.events += 1;
    summary.revisions += await countCollection(event.ref.collection("revisions"));
  }

  return summary;
}

async function inspectTarget(targetDb) {
  return {
    clients: await countCollection(targetDb.collection("clients")),
    events: await countCollection(targetDb.collection("events")),
    revisions: await countCollection(targetDb.collectionGroup("revisions"))
  };
}

async function copyData(sourceDb, targetDb) {
  let batch = targetDb.batch();
  let pendingWrites = 0;
  const copied = { clients: 0, events: 0, revisions: 0 };

  const flush = async () => {
    if (!pendingWrites) return;
    await batch.commit();
    batch = targetDb.batch();
    pendingWrites = 0;
  };

  const enqueue = async (targetRef, data, category) => {
    batch.set(targetRef, data);
    pendingWrites += 1;
    copied[category] += 1;

    if (pendingWrites >= WRITE_BATCH_SIZE) {
      await flush();
    }
  };

  for await (const client of readCollection(sourceDb.collection("clients"))) {
    await enqueue(targetDb.collection("clients").doc(client.id), client.data(), "clients");
  }

  for await (const event of readCollection(sourceDb.collection("events"))) {
    const targetEvent = targetDb.collection("events").doc(event.id);
    await enqueue(targetEvent, event.data(), "events");

    for await (const revision of readCollection(event.ref.collection("revisions"))) {
      await enqueue(targetEvent.collection("revisions").doc(revision.id), revision.data(), "revisions");
    }
  }

  await flush();
  return copied;
}

function printHelp() {
  console.log(`Uso:
  npm run copy:staging -- --dry-run
  npm run copy:staging -- --execute --confirm-target=${EXPECTED_TARGET_PROJECT}

Requer Google Application Default Credentials com acesso aos dois projetos.
Copia somente clients, events e events/{id}/revisions. Não copia users nem Auth.`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const sourceProject = process.env.COPY_SOURCE_PROJECT_ID || EXPECTED_SOURCE_PROJECT;
  const targetProject = process.env.COPY_TARGET_PROJECT_ID || EXPECTED_TARGET_PROJECT;
  validateProjects(sourceProject, targetProject, options);

  const credential = applicationDefault();
  const sourceApp = initializeApp({ credential, projectId: sourceProject }, "copy-source");
  const targetApp = initializeApp({ credential, projectId: targetProject }, "copy-target");

  try {
    const sourceDb = getFirestore(sourceApp);
    const targetDb = getFirestore(targetApp);
    const sourceBefore = await inspectSource(sourceDb);
    const targetBefore = await inspectTarget(targetDb);

    console.log(JSON.stringify({ mode: options.dryRun ? "dry-run" : "execute", sourceBefore, targetBefore }, null, 2));

    if (Object.values(targetBefore).some((count) => count > 0)) {
      throw new Error("Destino já contém dados operacionais; a cópia inicial foi recusada.");
    }

    if (options.dryRun) {
      console.log("Simulação concluída. Nenhum dado foi alterado.");
      return;
    }

    const copied = await copyData(sourceDb, targetDb);
    const targetAfter = await inspectTarget(targetDb);

    if (JSON.stringify(copied) !== JSON.stringify(sourceBefore)) {
      throw new Error("A quantidade copiada diverge da origem.");
    }

    if (JSON.stringify(targetAfter) !== JSON.stringify(sourceBefore)) {
      throw new Error("A verificação final do destino diverge da origem.");
    }

    console.log(JSON.stringify({ copied, targetAfter }, null, 2));
    console.log("Cópia inicial concluída e verificada.");
  } finally {
    await Promise.all([deleteApp(sourceApp), deleteApp(targetApp)]);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
