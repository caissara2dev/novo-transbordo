import fs from "node:fs";
import path from "node:path";
import { cert, getApps, initializeApp } from "firebase-admin/app";

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

function getProjectId() {
  return (
    cleanEnv(process.env.FIREBASE_PROJECT_ID) ||
    cleanEnv(process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID) ||
    cleanEnv(process.env.GCLOUD_PROJECT)
  );
}

async function promoteViaEmulator({ uid, projectId, emulatorHost }) {
  const baseUrl = `http://${emulatorHost}/v1/projects/${projectId}/databases/(default)/documents/users/${uid}`;
  const ownerHeaders = {
    Authorization: "Bearer owner"
  };

  let checkRes;
  try {
    checkRes = await fetch(baseUrl, {
      headers: ownerHeaders
    });
  } catch {
    throw new Error(
      `Nao foi possivel conectar ao Firestore Emulator em ${emulatorHost}. ` +
        `Confirme se 'npx firebase emulators:start' esta rodando.`
    );
  }
  if (checkRes.status === 404) {
    throw new Error(`Usuario ${uid} nao encontrado em users/{uid}.`);
  }
  if (!checkRes.ok) {
    const payload = await checkRes.text();
    throw new Error(`Falha ao consultar usuario no emulador: ${payload}`);
  }

  const now = new Date().toISOString();
  const patchUrl =
    `${baseUrl}?updateMask.fieldPaths=role` +
    `&updateMask.fieldPaths=approved` +
    `&updateMask.fieldPaths=approvedAt` +
    `&updateMask.fieldPaths=updatedAt`;

  let patchRes;
  try {
    patchRes = await fetch(patchUrl, {
      method: "PATCH",
      headers: {
        ...ownerHeaders,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        fields: {
          role: { stringValue: "ADMIN" },
          approved: { booleanValue: true },
          approvedAt: { timestampValue: now },
          updatedAt: { timestampValue: now }
        }
      })
    });
  } catch {
    throw new Error(`Conexao perdida com o Firestore Emulator em ${emulatorHost}.`);
  }

  if (!patchRes.ok) {
    const payload = await patchRes.text();
    throw new Error(`Falha ao atualizar usuario no emulador: ${payload}`);
  }
}

function bootAdminForCloud(projectId) {
  if (getApps().length) {
    return;
  }

  const clientEmail = cleanEnv(process.env.FIREBASE_CLIENT_EMAIL);
  const privateKey = cleanEnv(process.env.FIREBASE_PRIVATE_KEY)?.replace(/\\n/g, "\n");

  if (clientEmail && privateKey) {
    initializeApp({
      credential: cert({ projectId, clientEmail, privateKey })
    });
    return;
  }

  initializeApp({ projectId });
}

async function promoteViaCloud(uid, projectId) {
  bootAdminForCloud(projectId);

  const { getFirestore, FieldValue } = await import("firebase-admin/firestore");
  const db = getFirestore();
  const ref = db.collection("users").doc(uid);
  const snap = await ref.get();

  if (!snap.exists) {
    throw new Error(`Usuario ${uid} nao encontrado em users/{uid}.`);
  }

  await ref.update({
    role: "ADMIN",
    approved: true,
    approvedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  });
}

async function main() {
  const uid = process.argv[2];

  if (!uid) {
    throw new Error("Uso: npm run promote-admin -- <uid>");
  }

  loadLocalEnv();

  const projectId = getProjectId();
  if (!projectId) {
    throw new Error("Project ID nao encontrado. Defina FIREBASE_PROJECT_ID no .env.local.");
  }

  const emulatorHost = cleanEnv(process.env.FIRESTORE_EMULATOR_HOST);

  if (emulatorHost) {
    await promoteViaEmulator({ uid, projectId, emulatorHost });
  } else {
    await promoteViaCloud(uid, projectId);
  }

  console.log(`Usuario ${uid} promovido para ADMIN e aprovado.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
