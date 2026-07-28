export const PRODUCTION_PROJECT_ID = "line-transbordo";
export const PRODUCTION_CONFIRMATION = "PROMOTE_ADMIN_IN_PRODUCTION";

function getArgumentValue(argv, name) {
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

  const positional = argv.filter((arg) => !arg.startsWith("--"));
  if (positional.length > 1) {
    throw new Error("Informe apenas um UID.");
  }
  if (argv.includes("--execute") && argv.includes("--dry-run")) {
    throw new Error("Use apenas --dry-run ou --execute, nunca ambos.");
  }

  const execute = argv.includes("--execute");
  return {
    help: argv.includes("--help"),
    uid: positional[0] || null,
    projectId: getArgumentValue(argv, "--project"),
    execute,
    dryRun: !execute,
    confirmation: getArgumentValue(argv, "--confirm-project"),
    allowProduction: argv.includes("--allow-production"),
    productionConfirmation: getArgumentValue(argv, "--confirm-production")
  };
}

export function validatePromotionRequest(options) {
  if (!options.uid) {
    throw new Error("Informe o UID do usuário.");
  }
  if (options.uid.length > 128 || /[\u0000-\u001f\u007f]/.test(options.uid)) {
    throw new Error("UID inválido.");
  }
  if (!options.projectId) {
    throw new Error("Selecione explicitamente o projeto com --project=<project-id>.");
  }
  if (!options.execute) {
    return;
  }
  if (options.confirmation !== options.projectId) {
    throw new Error(
      `Para executar, confirme o projeto com --confirm-project=${options.projectId}.`
    );
  }
  if (options.projectId !== PRODUCTION_PROJECT_ID) {
    return;
  }
  if (!options.allowProduction) {
    throw new Error(
      "Produção bloqueada. Acrescente --allow-production se esta ação for intencional."
    );
  }
  if (options.productionConfirmation !== PRODUCTION_CONFIRMATION) {
    throw new Error(
      `Produção exige --confirm-production=${PRODUCTION_CONFIRMATION}.`
    );
  }
}

export function buildPromotionPatch(nowIso) {
  return {
    role: "ADMIN",
    approved: true,
    approvedAt: nowIso,
    updatedAt: nowIso
  };
}
