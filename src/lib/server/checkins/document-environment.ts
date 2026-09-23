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
