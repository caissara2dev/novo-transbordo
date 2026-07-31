import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { findServerBundleViolations } from "./lib/server-bundle-policy.mjs";

const serverDirectory = path.resolve(".next/server");
const clientDirectory = path.resolve(".next/static");

async function listJavaScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        return listJavaScriptFiles(entryPath);
      }

      return entry.isFile() && entry.name.endsWith(".js") ? [entryPath] : [];
    })
  );

  return nestedFiles.flat();
}

async function readBundleFiles(directory) {
  const files = await listJavaScriptFiles(directory);
  return Promise.all(
    files.map(async (file) => ({
      path: path.relative(process.cwd(), file),
      source: await readFile(file, "utf8")
    }))
  );
}

try {
  const [serverFiles, clientFiles] = await Promise.all([
    readBundleFiles(serverDirectory),
    readBundleFiles(clientDirectory)
  ]);
  const violations = findServerBundleViolations({ serverFiles, clientFiles });

  if (violations.length) {
    console.error("Server bundle policy failed:");

    for (const violation of violations) {
      console.error(`- [${violation.code}] ${violation.file}: ${violation.message}`);
    }

    process.exitCode = 1;
  } else {
    console.log(
      "Server bundle check passed: Firebase Admin is bundled only on the server."
    );
  }
} catch (error) {
  if (error?.code === "ENOENT") {
    console.error("Build output not found. Run `npm run build` before this check.");
    process.exitCode = 1;
  } else {
    throw error;
  }
}
