import { createHmac } from "node:crypto";

export const EXPECTED_SOURCE_PROJECT = "line-transbordo";
export const EXPECTED_TARGET_PROJECT = "line-transbordo-staging-382612";
export const STAGING_RETENTION_DAYS = 7;

const SAFE_OPERATIONAL_STRING_FIELDS = new Set([
  "action",
  "category",
  "containerStatus",
  "endTime",
  "origin",
  "pump",
  "shiftDate",
  "shiftType",
  "startTime",
  "status",
  "type"
]);

export function parseArgs(argv) {
  const execute = argv.includes("--execute");
  const dryRun = argv.includes("--dry-run") || !execute;
  const confirmationArg = argv.find((arg) => arg.startsWith("--confirm-target="));
  const unknown = argv.find(
    (arg) =>
      arg.startsWith("--") &&
      !["--help", "--execute", "--dry-run"].includes(arg) &&
      !arg.startsWith("--confirm-target=")
  );

  if (unknown) {
    throw new Error(`Argumento desconhecido: ${unknown}.`);
  }
  if (argv.includes("--execute") && argv.includes("--dry-run")) {
    throw new Error("Use apenas --dry-run ou --execute, nunca ambos.");
  }

  return {
    help: argv.includes("--help"),
    execute,
    dryRun,
    confirmation: confirmationArg?.slice("--confirm-target=".length) || null
  };
}

export function validateProjects(sourceProject, targetProject, options) {
  if (sourceProject !== EXPECTED_SOURCE_PROJECT) {
    throw new Error(`Origem recusada: esperado ${EXPECTED_SOURCE_PROJECT}.`);
  }
  if (targetProject !== EXPECTED_TARGET_PROJECT) {
    throw new Error(`Destino recusado: esperado ${EXPECTED_TARGET_PROJECT}.`);
  }
  if (sourceProject === targetProject || targetProject === EXPECTED_SOURCE_PROJECT) {
    throw new Error("Operação recusada: o destino não pode ser a produção.");
  }
  if (options.execute && options.confirmation !== EXPECTED_TARGET_PROJECT) {
    throw new Error(`Para executar, informe --confirm-target=${EXPECTED_TARGET_PROJECT}.`);
  }
}

function digest(scope, value, secret, length = 12) {
  return createHmac("sha256", secret)
    .update(`${scope}:${String(value)}`)
    .digest("hex")
    .slice(0, length);
}

function anonymizedId(kind, value, secret) {
  return `${kind}-${digest(kind, value, secret)}`;
}

export function anonymizeDocumentId(collection, documentId, secret) {
  const kindByCollection = {
    clients: "client",
    events: "event",
    revisions: "revision"
  };
  const kind = kindByCollection[collection];
  if (!kind) {
    throw new Error(`Coleção sem política de anonimização: ${collection}.`);
  }
  return anonymizedId(kind, documentId, secret);
}

function anonymizeEmail(value, secret) {
  return `actor-${digest("email", value, secret)}@example.invalid`;
}

function anonymizeClientName(sourceClientId, secret) {
  return `Cliente ${digest("client", sourceClientId, secret, 8).toUpperCase()}`;
}

function anonymizePlate(value, secret) {
  const hash = digest("plate", value, secret).toUpperCase();
  const digits = [...hash].filter((character) => /\d/.test(character));
  const letters = [...hash].filter((character) => /[A-F]/.test(character));
  const digit = (index) => digits[index] || String(index);
  return `TST-${digit(0)}${letters[0] || "A"}${digit(1)}${digit(2)}`;
}

function anonymizeText(value, secret) {
  return `Texto anonimizado ${digest("text", value, secret, 8).toUpperCase()}`;
}

function referenceKind(key) {
  if (/eventId$/i.test(key)) return "event";
  if (/clientId$/i.test(key)) return "client";
  if (/cycleId$/i.test(key)) return "cycle";
  if (/gap(?:Segment)?Id$/i.test(key)) return "gap";
  if (/Id$/.test(key)) return "id";
  return null;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function anonymizeString(key, value, sourceRecord, context) {
  if (/email/i.test(key) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return anonymizeEmail(value, context.secret);
  }
  if (/uid$/i.test(key)) {
    return anonymizedId("uid", value, context.secret);
  }

  const idKind = referenceKind(key);
  if (idKind) {
    return anonymizedId(idKind, value, context.secret);
  }

  const sourceClientId =
    typeof sourceRecord.clientId === "string"
      ? sourceRecord.clientId
      : context.sourceClientId;
  if (key === "clientNameSnapshot") {
    return anonymizeClientName(sourceClientId || value, context.secret);
  }
  if (key === "name" || key === "nameUpper") {
    const name = anonymizeClientName(sourceClientId || value, context.secret);
    return key === "nameUpper" ? name.toUpperCase() : name;
  }
  if (key === "plate") {
    return anonymizePlate(value, context.secret);
  }
  if (key === "container") {
    return `CT-${digest("container", value, context.secret).toUpperCase()}`;
  }
  if (/notes?|reason|comment|description/i.test(key)) {
    return anonymizeText(value, context.secret);
  }
  if (SAFE_OPERATIONAL_STRING_FIELDS.has(key)) {
    return value;
  }
  return `anon-${digest("string", value, context.secret)}`;
}

function anonymizeValue(key, value, sourceRecord, context) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return anonymizeString(key, value, sourceRecord, context);
  }
  if (Array.isArray(value)) {
    return value.map((item) => anonymizeValue(key, item, sourceRecord, context));
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    throw new Error(`Campo binário não suportado na cópia anonimizada: ${key}.`);
  }
  if (!isPlainObject(value)) {
    if (value?.constructor?.name === "DocumentReference") {
      throw new Error(`DocumentReference não suportada na cópia anonimizada: ${key}.`);
    }
    return value;
  }

  const nestedSourceClientId =
    typeof value.clientId === "string" ? value.clientId : context.sourceClientId;
  return anonymizeRecord(value, {
    ...context,
    sourceClientId: nestedSourceClientId
  });
}

function anonymizeRecord(data, context) {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([key]) => key !== "expiresAt")
      .map(([key, value]) => [key, anonymizeValue(key, value, data, context)])
  );
}

export function anonymizeDocument({
  collection,
  documentId,
  data,
  secret,
  expiresAt
}) {
  if (!secret) {
    throw new Error("A chave de anonimização é obrigatória.");
  }
  const sourceClientId = collection === "clients" ? documentId : data.clientId;
  return {
    ...anonymizeRecord(data, { secret, sourceClientId }),
    expiresAt
  };
}
