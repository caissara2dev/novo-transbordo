import { describe, expect, it } from "vitest";

import {
  PRODUCTION_CONFIRMATION,
  PRODUCTION_PROJECT_ID,
  buildPromotionPatch,
  parseArgs,
  validatePromotionRequest
} from "../../scripts/promote-admin.mjs";

describe("promote-admin CLI policy", () => {
  it("defaults to a read-only plan for an explicitly selected project", () => {
    const options = parseArgs(["user-123", "--project=demo-transbordo"]);

    expect(options).toEqual({
      help: false,
      uid: "user-123",
      projectId: "demo-transbordo",
      execute: false,
      dryRun: true,
      confirmation: null,
      allowProduction: false,
      productionConfirmation: null
    });
    expect(() => validatePromotionRequest(options)).not.toThrow();
  });

  it("requires an exact project confirmation before any write", () => {
    const options = parseArgs([
      "user-123",
      "--project=demo-transbordo",
      "--execute",
      "--confirm-project=another-project"
    ]);

    expect(() => validatePromotionRequest(options)).toThrow(
      "confirme o projeto com --confirm-project=demo-transbordo"
    );
  });

  it("rejects ambiguous or unknown CLI input", () => {
    expect(() => parseArgs(["one", "two", "--project=demo-transbordo"])).toThrow(
      "Informe apenas um UID"
    );
    expect(() =>
      parseArgs([
        "user-123",
        "--project=demo-transbordo",
        "--execute",
        "--dry-run"
      ])
    ).toThrow("nunca ambos");
    expect(() =>
      parseArgs(["user-123", "--project=demo-transbordo", "--force"])
    ).toThrow("Argumento desconhecido");
  });

  it("requires a valid UID and an explicit project", () => {
    expect(() =>
      validatePromotionRequest(parseArgs(["--project=demo-transbordo"]))
    ).toThrow("Informe o UID");
    expect(() =>
      validatePromotionRequest(parseArgs([`bad\u0000uid`, "--project=demo-transbordo"]))
    ).toThrow("UID inválido");
    expect(() => validatePromotionRequest(parseArgs(["user-123"]))).toThrow(
      "--project=<project-id>"
    );
  });

  it("requires an additional explicit production acknowledgement", () => {
    const options = parseArgs([
      "user-123",
      `--project=${PRODUCTION_PROJECT_ID}`,
      "--execute",
      `--confirm-project=${PRODUCTION_PROJECT_ID}`,
      "--allow-production",
      `--confirm-production=${PRODUCTION_CONFIRMATION}`
    ]);

    expect(() => validatePromotionRequest(options)).not.toThrow();

    const missingAcknowledgement = {
      ...options,
      productionConfirmation: null
    };
    expect(() => validatePromotionRequest(missingAcknowledgement)).toThrow(
      `--confirm-production=${PRODUCTION_CONFIRMATION}`
    );

    expect(() =>
      validatePromotionRequest({
        ...options,
        allowProduction: false
      })
    ).toThrow("Produção bloqueada");
  });

  it("builds the intended promotion without mutating the current profile", () => {
    const current = {
      role: "OPERATOR",
      approved: false,
      name: "Pessoa preservada"
    };

    const patch = buildPromotionPatch("2026-07-28T12:00:00.000Z");

    expect(patch).toEqual({
      role: "ADMIN",
      approved: true,
      approvedAt: "2026-07-28T12:00:00.000Z",
      updatedAt: "2026-07-28T12:00:00.000Z"
    });
    expect(current).toEqual({
      role: "OPERATOR",
      approved: false,
      name: "Pessoa preservada"
    });
  });
});
