import "server-only";
import { HttpError } from "@/lib/domain/errors";

const stagingProject = "line-transbordo-staging-382612";
const productionProject = "line-transbordo";
const emulatorVariables = [
  "FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST",
  "STORAGE_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST",
] as const;

/** Validate before creating any storage capability. Production requires an explicit opt-in. */
export function documentEnvironment(env: NodeJS.ProcessEnv = process.env) {
  if (env.CHECKIN_DOCUMENTS_ENABLED !== "true")
    throw new HttpError(503, "Envio de notas indisponível.");
  const project = env.FIREBASE_PROJECT_ID;
  const environment = env.CHECKIN_DOCUMENT_ENVIRONMENT;
  const bucket = env.CHECKIN_DOCUMENT_BUCKET;
  const origin = env.CHECKIN_PORTAL_ORIGIN;
  const secret = env.CHECKIN_INDEX_HMAC_SECRET;
  const demo = project?.startsWith("demo-") && !!env.FIRESTORE_EMULATOR_HOST;
  const production = project === productionProject && environment === "production";
  const staging = project === stagingProject && (!environment || environment === "staging");

  if ((!demo && !production && !staging) ||
      (demo && environment && environment !== "demo") ||
      (!demo && emulatorVariables.some((name) => !!env[name])))
    throw new HttpError(503, "Ambiente documental não habilitado.");
  if (!bucket || !origin || !secret || secret.length < 32)
    throw new HttpError(503, "Configuração documental incompleta.");
  if (demo && !bucket.startsWith("demo-"))
    throw new HttpError(503, "Configuração documental não corresponde ao ambiente.");
  if (!demo && (bucket !== `${project}-checkin-nf` || origin !== (production
    ? "https://checkin.linebot.com.br"
    : `https://checkin-portal-nf--${stagingProject}.us-central1.hosted.app`)))
    throw new HttpError(503, "Configuração documental não corresponde ao ambiente.");
  return { bucket, origin, secret };
}

/** Internal uploads share the document boundary but use the staff application's origin. */
export function internalDocumentOrigin(env: NodeJS.ProcessEnv = process.env) {
  documentEnvironment(env);
  const origin = env.CHECKIN_DOCUMENT_INTERNAL_ORIGIN;
  const demo = env.FIREBASE_PROJECT_ID?.startsWith("demo-") && !!env.FIRESTORE_EMULATOR_HOST;
  const expected = env.FIREBASE_PROJECT_ID === productionProject
    ? "https://linebot.com.br"
    : `https://checkin-system-nf--${stagingProject}.us-central1.hosted.app`;
  if (!origin || (!demo && origin !== expected))
    throw new HttpError(503, "Origem interna do envio documental não configurada.");
  return origin;
}
