import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const productionWebConfig = {
  appId: "1:382612530713:web:fea8995134ab67f3caec88"
};

function readEnvironmentValue(variable: string): string | undefined {
  const manifest = readFileSync("apphosting.yaml", "utf8");
  const block = manifest
    .split(/\n  - variable: /)
    .find((candidate) => candidate.startsWith(`${variable}\n`));

  return block?.match(/\n    value: "([^"]*)"/)?.[1];
}

describe("configuração pública do App Hosting de produção", () => {
  it("usa o app Web registrado no Firebase de produção", () => {
    expect(readEnvironmentValue("NEXT_PUBLIC_FIREBASE_API_KEY")).toMatch(
      /^AIza[\w-]{30,}$/
    );
    expect(readEnvironmentValue("NEXT_PUBLIC_FIREBASE_APP_ID")).toBe(
      productionWebConfig.appId
    );
  });

  it("mantém a allowlist do App Check alinhada ao App ID público", () => {
    expect(readEnvironmentValue("APP_CHECK_ALLOWED_APP_IDS")).toBe(
      readEnvironmentValue("NEXT_PUBLIC_FIREBASE_APP_ID")
    );
  });
});
