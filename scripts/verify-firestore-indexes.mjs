import { readFile } from "node:fs/promises";
import { findMissingEventHistoryIndexes } from "./lib/firestore-index-policy.mjs";

const manifestUrl = new URL("../firestore.indexes.json", import.meta.url);

try {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  const missing = findMissingEventHistoryIndexes(manifest);

  if (missing.length) {
    console.error(
      [
        "O manifesto não cobre todas as consultas do histórico:",
        ...missing.map((signature) => `- ${signature}`)
      ].join("\n")
    );
    process.exitCode = 1;
  } else {
    console.log(
      "Manifesto validado: 7 índices do histórico estão declarados."
    );
  }
} catch (error) {
  console.error(
    "Não foi possível validar firestore.indexes.json.",
    error
  );
  process.exitCode = 1;
}
