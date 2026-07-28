import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cert, deleteApp, getApps, initializeApp } from "firebase-admin/app";
import {
  PRODUCTION_CONFIRMATION,
  buildPromotionPatch,
  parseArgs,
  validatePromotionRequest
} from "./lib/promote-admin-policy.mjs";

export {
  PRODUCTION_CONFIRMATION,
  PRODUCTION_PROJECT_ID,
  buildPromotionPatch,
  parseArgs,
  validatePromotionRequest
} from "./lib/promote-admin-policy.mjs";

function cleanEnv(value) {
  if (!value) return undefined;
  const cleaned = value.trim().replace(/^"(.*)"$/, "$1");
  if (!cleaned || cleaned === "replace_me") return undefined;
  return cleaned;
}

function loadLocalEnv() {
  const cwd = process.cwd();
  const envFiles = [".env.local", ".env"];

  for (const fileName of envFiles) {
    const filePath = path.join(cwd, fileName);
    if (!fs.existsSync(filePath)) continue;

    const content = fs.readFileSync(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const eqIndex = trimmed.indexOf("=");
      if (eqIndex <= 0) continue;

      const key = trimmed.slice(0, eqIndex).trim();
      const rawValue = trimmed.slice(eqIndex + 1).trim();
      if (!key || process.env[key] !== undefined) continue;
      process.env[key] = cleanEnv(rawValue) ?? rawValue;
    }
  }
}

function firestoreValue(value) {
  if (typeof value === "boolean") {
    return { booleanValue: value };
  }
  return value === null || value === undefined
    ? { nullValue: null }
    : { stringValue: String(value) };
}

function summarizeEmulatorDocument(payload) {
  const fields = payload?.fields || {};
  return {
    role: fields.role?.stringValue || null,
    approved: fields.approved?.booleanValue === true
  };
}

async function promoteViaEmulator({ uid, projectId, emulatorHost, execute, patch }) {
  const baseUrl =
    `http://${emulatorHost}/v1/projects/${projectId}` +
    `/databases/(default)/documents/users/${encodeURIComponent(uid)}`;
  const ownerHeaders = { Authorization: "Bearer owner" };

  let checkRes;
  try {
    checkRes = await fetch(baseUrl, { headers: ownerHeaders });
  } catch {
    throw new Error(
      `Não foi possível conectar ao Firestore Emulator em ${emulatorHost}. ` +
        "Confirme se 'npx firebase emulators:start' está rodando."
    );
  }
  if (checkRes.status === 404) {
    throw new Error(`Usuário ${uid} não encontrado em users/{uid}.`);
  }
  if (!checkRes.ok) {
    throw new Error(`Falha ao consultar usuário no emulador: ${await checkRes.text()}`);
  }

  const current = summarizeEmulatorDocument(await checkRes.json());
  if (!execute) {
    return { current, executed: false };
  }

  const patchUrl =
    `${baseUrl}?updateMask.fieldPaths=role` +
    "&updateMask.fieldPaths=approved" +
    "&updateMask.fieldPaths=approvedAt" +
    "&updateMask.fieldPaths=updatedAt";
  let patchRes;
  try {
    patchRes = await fetch(patchUrl, {
      method: "PATCH",
      headers: { ...ownerHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: Object.fromEntries(
          Object.entries(patch).map(([key, value]) => [
            key,
            key.endsWith("At") ? { timestampValue: value } : firestoreValue(value)
          ])
        )
      })
    });
  } catch {
    throw new Error(`Conexão perdida com o Firestore Emulator em ${emulatorHost}.`);
  }

  if (!patchRes.ok) {
    throw new Error(`Falha ao atualizar usuário no emulador: ${await patchRes.text()}`);
  }
  return { current, executed: true };
}

function bootAdminForCloud(projectId) {
  const appName = `promote-admin-${projectId}`;
  const existing = getApps().find((app) => app.name === appName);
  if (existing) return existing;

  const clientEmail = cleanEnv(process.env.FIREBASE_CLIENT_EMAIL);
  const privateKey = cleanEnv(process.env.FIREBASE_PRIVATE_KEY)?.replace(/\\n/g, "\n");
  if (clientEmail && privateKey) {
    return initializeApp(
      { credential: cert({ projectId, clientEmail, privateKey }), projectId },
      appName
    );
  }
  return initializeApp({ projectId }, appName);
}

async function promoteViaCloud({ uid, projectId, execute }) {
  const app = bootAdminForCloud(projectId);
  try {
    const { FieldValue, getFirestore } = await import("firebase-admin/firestore");
    const ref = getFirestore(app).collection("users").doc(uid);
    const snap = await ref.get();
    if (!snap.exists) {
      throw new Error(`Usuário ${uid} não encontrado em users/{uid}.`);
    }

    const data = snap.data() || {};
    const current = {
      role: typeof data.role === "string" ? data.role : null,
      approved: data.approved === true
    };
    if (!execute) {
      return { current, executed: false };
    }

    await ref.update({
      role: "ADMIN",
      approved: true,
      approvedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
    return { current, executed: true };
  } finally {
    await deleteApp(app);
  }
}

function printHelp() {
  console.log(`Uso:
  npm run promote-admin -- <uid> --project=<project-id> --dry-run
  npm run promote-admin -- <uid> --project=<project-id> --execute --confirm-project=<project-id>

Produção também exige:
  --allow-production --confirm-production=${PRODUCTION_CONFIRMATION}

O modo padrão é dry-run. Credenciais são lidas do ambiente; o projeto nunca é inferido.`);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }

  validatePromotionRequest(options);
  loadLocalEnv();

  const patch = buildPromotionPatch(new Date().toISOString());
  const emulatorHost = cleanEnv(process.env.FIRESTORE_EMULATOR_HOST);
  const result = emulatorHost
    ? await promoteViaEmulator({
        uid: options.uid,
        projectId: options.projectId,
        emulatorHost,
        execute: options.execute,
        patch
      })
    : await promoteViaCloud({
        uid: options.uid,
        projectId: options.projectId,
        execute: options.execute
      });

  console.log(
    JSON.stringify(
      {
        mode: options.dryRun ? "dry-run" : "execute",
        projectId: options.projectId,
        uid: options.uid,
        current: result.current,
        intended: { role: patch.role, approved: patch.approved },
        executed: result.executed
      },
      null,
      2
    )
  );
  if (!result.executed) {
    console.log("Simulação concluída. Nenhum dado foi alterado.");
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
