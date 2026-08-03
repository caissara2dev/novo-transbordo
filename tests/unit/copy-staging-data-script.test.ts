import { describe, expect, it } from "vitest";

import {
  EXPECTED_SOURCE_PROJECT,
  EXPECTED_TARGET_PROJECT,
  anonymizeDocument,
  anonymizeDocumentId,
  parseArgs,
  validateProjects
} from "../../scripts/copy-staging-data.mjs";

describe("copy-staging CLI policy", () => {
  it("defaults to dry-run and requires the fixed staging target", () => {
    const options = parseArgs([]);

    expect(options).toEqual({
      help: false,
      execute: false,
      dryRun: true,
      confirmation: null
    });
    expect(() =>
      validateProjects(EXPECTED_SOURCE_PROJECT, EXPECTED_TARGET_PROJECT, options)
    ).not.toThrow();
    expect(() =>
      validateProjects(EXPECTED_SOURCE_PROJECT, "line-transbordo-preview", options)
    ).toThrow("Destino recusado");
  });

  it("rejects ambiguous flags and requires exact execute confirmation", () => {
    expect(() => parseArgs(["--execute", "--dry-run"])).toThrow("nunca ambos");
    expect(() => parseArgs(["--force"])).toThrow("Argumento desconhecido");
    expect(() =>
      validateProjects("other-production", EXPECTED_TARGET_PROJECT, parseArgs([]))
    ).toThrow("Origem recusada");
    expect(() =>
      validateProjects(
        EXPECTED_SOURCE_PROJECT,
        EXPECTED_TARGET_PROJECT,
        parseArgs(["--execute"])
      )
    ).toThrow(`--confirm-target=${EXPECTED_TARGET_PROJECT}`);
    expect(
      parseArgs([
        "--execute",
        `--confirm-target=${EXPECTED_TARGET_PROJECT}`
      ])
    ).toMatchObject({ execute: true, dryRun: false });
  });
});

describe("staging anonymization", () => {
  it("anonymizes identifiers and PII deterministically while preserving operations", () => {
    const source = {
      clientId: "client-1",
      clientNameSnapshot: "Acme Transportes",
      plate: "ABC-1234",
      container: "CONT-123",
      notes: "Telefone do motorista: 11999999999",
      createdByUid: "user-1",
      createdByEmail: "operator@example.com",
      pump: "BOMBA_3",
      category: "PRODUTIVO",
      shiftDate: "2026-07-28",
      nested: {
        deletedReason: "Pedido de João",
        previousContainerEventId: "event-previous"
      }
    };
    const expiresAt = new Date("2026-08-04T12:00:00.000Z");

    const anonymized = anonymizeDocument({
      collection: "events",
      documentId: "event-1",
      data: source,
      secret: "test-secret",
      expiresAt
    });
    const repeated = anonymizeDocument({
      collection: "events",
      documentId: "event-1",
      data: source,
      secret: "test-secret",
      expiresAt
    });

    expect(anonymized).toEqual(repeated);
    expect(anonymized).toMatchObject({
      clientId: "client-6feb5657e02b",
      clientNameSnapshot: "Cliente 6FEB5657",
      plate: "TST-9F33",
      container: "CT-B12C50C47A36",
      notes: "Texto anonimizado 7F4C57BB",
      createdByUid: "uid-1eccb29fda6a",
      createdByEmail: "actor-904eed96765f@example.invalid",
      pump: "BOMBA_3",
      category: "PRODUTIVO",
      shiftDate: "2026-07-28",
      nested: {
        deletedReason: "Texto anonimizado D33F3C51",
        previousContainerEventId: "event-c2384166f787"
      },
      expiresAt
    });
    expect(JSON.stringify(anonymized)).not.toContain("Acme");
    expect(JSON.stringify(anonymized)).not.toContain("11999999999");
    expect(JSON.stringify(anonymized)).not.toContain("operator@example.com");
    expect(source.clientId).toBe("client-1");
  });

  it("uses deterministic target document ids for every copied collection", () => {
    expect(anonymizeDocumentId("clients", "client-1", "test-secret")).toBe(
      "client-6feb5657e02b"
    );
    expect(anonymizeDocumentId("events", "event-1", "test-secret")).toBe(
      "event-7303a6994859"
    );
    expect(anonymizeDocumentId("revisions", "revision-1", "test-secret")).toBe(
      "revision-0567a0d879c0"
    );
    expect(() =>
      anonymizeDocumentId("unknown" as "events", "one", "test-secret")
    ).toThrow("Coleção sem política");
  });

  it("sanitizes nested collections and rejects unsupported binary/reference data", () => {
    const expiresAt = new Date("2026-08-04T12:00:00.000Z");
    const anonymized = anonymizeDocument({
      collection: "clients",
      documentId: "client-1",
      data: {
        name: "Cliente real",
        nameUpper: "CLIENTE REAL",
        aliases: ["Contato real", null],
        contact: "contact@example.com",
        eventId: "event-1",
        containerCycleId: "cycle-1",
        gapSegmentId: "gap-1",
        customId: "sensitive-id",
        expiresAt: new Date("2027-01-01T00:00:00.000Z"),
        createdAt: new Date("2026-07-28T00:00:00.000Z")
      },
      secret: "test-secret",
      expiresAt
    });

    expect(anonymized).toMatchObject({
      name: "Cliente 6FEB5657",
      nameUpper: "CLIENTE 6FEB5657",
      contact: "actor-d40cf8634fc7@example.invalid",
      eventId: "event-7303a6994859",
      containerCycleId: "cycle-b162411782a0",
      gapSegmentId: "gap-318bc494a4f6",
      customId: "id-952fd8ff7fe9",
      expiresAt
    });
    expect(anonymized.aliases).not.toContain("Contato real");
    expect(anonymized.createdAt).toEqual(new Date("2026-07-28T00:00:00.000Z"));

    expect(() =>
      anonymizeDocument({
        collection: "events",
        documentId: "event-1",
        data: { payload: Buffer.from("private") },
        secret: "test-secret",
        expiresAt
      })
    ).toThrow("Campo binário não suportado");

    class DocumentReference {}
    expect(() =>
      anonymizeDocument({
        collection: "events",
        documentId: "event-1",
        data: { linked: new DocumentReference() },
        secret: "test-secret",
        expiresAt
      })
    ).toThrow("DocumentReference não suportada");

    expect(() =>
      anonymizeDocument({
        collection: "events",
        documentId: "event-1",
        data: {},
        secret: "",
        expiresAt
      })
    ).toThrow("chave de anonimização");
  });
});
