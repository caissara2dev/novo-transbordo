import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";

const fixtures: string[] = [];

async function exportFixture(scriptTag: string, javascript: string) {
  const directory = await mkdtemp(join(tmpdir(), "checkin-standalone-"));
  fixtures.push(directory);
  const script = join(directory, "prototype/export-standalone.mjs");
  const build = join(directory, "outputs/checkin-prototype");
  await mkdir(join(directory, "prototype"));
  await mkdir(join(build, "assets"), { recursive: true });
  await copyFile(resolve("prototype/export-standalone.mjs"), script);
  await writeFile(join(build, "index.html"),
    `<!doctype html><html><head><link rel="stylesheet" href="./assets/app.css"></head><body><div id="root"></div>${scriptTag}</body></html>`);
  await writeFile(join(build, "assets/app.js"), javascript);
  await writeFile(join(build, "assets/app.css"), "#root { color: teal; }");
  const output = join(directory, "standalone.html");
  execFileSync(process.execPath, [script, output], { stdio: "pipe" });
  return readFile(output, "utf8");
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("exportação autônoma do protótipo", () => {
  it.each([
    '<script type="module" src="./assets/app.js"></script>',
    '<script type="module" src="./assets/app.js"></script >',
    '<SCRIPT type="module" SRC="./assets/app.js"></SCRIPT\t\n>',
    '<script type="module" src="./assets/app.js"></script data-ignored="value">',
    '<script type="module" src="./assets/app.js"></script/>'
  ])("incorpora o bundle com fechamento HTML válido: %s", async (scriptTag) => {
    const html = await exportFixture(scriptTag, 'globalThis.message = "Protótipo fictício";');
    expect(html).toContain('<script type="module">globalThis.message = "Protótipo fictício";</script>');
    expect(html).toContain("<style>#root { color: teal; }</style>");
    expect(html).not.toContain("./assets/");
    expect(html).toContain('<div id="root"></div>');
  });

  it("impede fechamento do script pelo conteúdo do bundle, preservando os valores JavaScript", async () => {
    const values = ["</script>", "</SCRIPT >", "</ScRiPt\t\n>", "</scripture>"];
    const html = await exportFixture(
      '<script type="module" src="./assets/app.js"></script>',
      `globalThis.messages = ${JSON.stringify(values)};`
    );
    // Only the real wrapper may expose an HTML script closing sequence.
    expect(html.toLowerCase().split("</script")).toHaveLength(2);
    const start = html.indexOf('<script type="module">') + '<script type="module">'.length;
    const javascript = html.slice(start, html.indexOf("</script>", start));
    const context: { messages?: string[] } = {};
    runInNewContext(javascript, context);
    expect(context.messages).toEqual(values);
  });
});
