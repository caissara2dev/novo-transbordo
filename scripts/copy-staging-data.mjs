import path from "node:path";
import { fileURLToPath } from "node:url";
import { applicationDefault, deleteApp, initializeApp } from "firebase-admin/app";
import { FieldPath, Timestamp, getFirestore } from "firebase-admin/firestore";
import {
  EXPECTED_SOURCE_PROJECT,
  EXPECTED_TARGET_PROJECT,
  STAGING_RETENTION_DAYS,
  anonymizeDocument,
  anonymizeDocumentId,
  parseArgs,
  validateProjects
} from "./lib/staging-copy-policy.mjs";

export {
  EXPECTED_SOURCE_PROJECT,
  EXPECTED_TARGET_PROJECT,
  STAGING_RETENTION_DAYS,
  anonymizeDocument,
  anonymizeDocumentId,
  parseArgs,
  validateProjects
} from "./lib/staging-copy-policy.mjs";

const PAGE_SIZE = 200;
const WRITE_BATCH_SIZE = 400;

async function* readCollection(collectionRef) {
  let cursor = null;
  while (true) {
    let query = collectionRef.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);

    const snapshot = await query.get();
    if (snapshot.empty) return;
    for (const doc of snapshot.docs) yield doc;

    cursor = snapshot.docs.at(-1);
    if (snapshot.size < PAGE_SIZE) return;
  }
}

async function countCollection(collectionRef) {
  const result = await collectionRef.count().get();
  return result.data().count;
}

async function inspectDatabase(db) {
  const [clients, events, revisions] = await Promise.all([
    countCollection(db.collection("clients")),
    countCollection(db.collection("events")),
    countCollection(db.collectionGroup("revisions"))
  ]);
  return { clients, events, revisions };
}

async function copyData(sourceDb, targetDb, { secret, expiresAt }) {
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
    if (pendingWrites >= WRITE_BATCH_SIZE) await flush();
  };

  for await (const client of readCollection(sourceDb.collection("clients"))) {
    const targetId = anonymizeDocumentId("clients", client.id, secret);
    await enqueue(
      targetDb.collection("clients").doc(targetId),
      anonymizeDocument({
        collection: "clients",
        documentId: client.id,
        data: client.data(),
        secret,
        expiresAt
      }),
      "clients"
    );
  }

  for await (const event of readCollection(sourceDb.collection("events"))) {
    const targetEventId = anonymizeDocumentId("events", event.id, secret);
    const targetEvent = targetDb.collection("events").doc(targetEventId);
    await enqueue(
      targetEvent,
      anonymizeDocument({
        collection: "events",
        documentId: event.id,
        data: event.data(),
        secret,
        expiresAt
      }),
      "events"
    );

    for await (const revision of readCollection(event.ref.collection("revisions"))) {
      const targetRevisionId = anonymizeDocumentId("revisions", revision.id, secret);
      await enqueue(
        targetEvent.collection("revisions").doc(targetRevisionId),
        anonymizeDocument({
          collection: "revisions",
          documentId: revision.id,
          data: revision.data(),
          secret,
          expiresAt
        }),
        "revisions"
      );
    }

    if (copied.events % 100 === 0) {
      console.log(
        `Progresso: ${copied.clients} clients, ${copied.events} events, ` +
          `${copied.revisions} revisions.`
      );
    }
  }

  await flush();
  return copied;
}

function printHelp() {
  console.log(`Uso:
  npm run copy:staging -- --dry-run
  COPY_ANONYMIZATION_KEY=<segredo> npm run copy:staging -- --execute --confirm-target=${EXPECTED_TARGET_PROJECT}

Requer Google Application Default Credentials com acesso aos dois projetos.
Copia somente clients, events e events/{id}/revisions. Não copia users nem Auth.
Todos os identificadores e campos textuais são pseudonimizados e recebem expiresAt
para retenção de ${STAGING_RETENTION_DAYS} dias.`);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }

  const sourceProject = process.env.COPY_SOURCE_PROJECT_ID || EXPECTED_SOURCE_PROJECT;
  const targetProject = process.env.COPY_TARGET_PROJECT_ID || EXPECTED_TARGET_PROJECT;
  validateProjects(sourceProject, targetProject, options);

  const secret = process.env.COPY_ANONYMIZATION_KEY?.trim();
  if (options.execute && (!secret || secret.length < 32)) {
    throw new Error("COPY_ANONYMIZATION_KEY deve conter ao menos 32 caracteres.");
  }

  const credential = applicationDefault();
  const sourceApp = initializeApp({ credential, projectId: sourceProject }, "copy-source");
  const targetApp = initializeApp({ credential, projectId: targetProject }, "copy-target");

  try {
    const sourceDb = getFirestore(sourceApp);
    const targetDb = getFirestore(targetApp);
    const [sourceBefore, targetBefore] = await Promise.all([
      inspectDatabase(sourceDb),
      inspectDatabase(targetDb)
    ]);

    console.log(
      JSON.stringify(
        {
          mode: options.dryRun ? "dry-run" : "execute",
          sourceBefore,
          targetBefore,
          anonymization: "deterministic-hmac",
          retentionDays: STAGING_RETENTION_DAYS
        },
        null,
        2
      )
    );

    if (Object.values(targetBefore).some((count) => count > 0)) {
      throw new Error("Destino já contém dados operacionais; a cópia inicial foi recusada.");
    }
    if (options.dryRun) {
      console.log("Simulação concluída. Nenhum dado foi alterado.");
      return;
    }

    const expiresAtDate = new Date(
      Date.now() + STAGING_RETENTION_DAYS * 24 * 60 * 60 * 1000
    );
    const copied = await copyData(sourceDb, targetDb, {
      secret,
      expiresAt: Timestamp.fromDate(expiresAtDate)
    });
    const targetAfter = await inspectDatabase(targetDb);

    if (JSON.stringify(copied) !== JSON.stringify(sourceBefore)) {
      throw new Error("A quantidade copiada diverge da origem.");
    }
    if (JSON.stringify(targetAfter) !== JSON.stringify(sourceBefore)) {
      throw new Error("A verificação final do destino diverge da origem.");
    }

    console.log(JSON.stringify({ copied, targetAfter, expiresAt: expiresAtDate }, null, 2));
    console.log("Cópia anonimizada concluída e verificada.");
  } finally {
    await Promise.all([deleteApp(sourceApp), deleteApp(targetApp)]);
  }
}

const isDirectInvocation =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectInvocation) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
