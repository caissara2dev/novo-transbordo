import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = path.join(
  process.cwd(),
  "outputs/checkin-v1/power-automate/include-checkin.office-script.ts.txt"
);
const SCHEMA_PATH = path.join(
  process.cwd(),
  "outputs/checkin-v1/power-automate/include-request.schema.json"
);
const SAMPLE_PATH = path.join(
  process.cwd(),
  "outputs/checkin-v1/power-automate/include-request.sample.json"
);

const HEADERS = [
  "Id",
  "Start time",
  "Completion time",
  "Email",
  "Name",
  "Language",
  "Nome completo do motorista",
  "CNH do motorista",
  "Telefone do motorista (com DDD)",
  "Placa",
  "Nome da Transportadora",
  "Tipo de veículo",
  "Produto",
  "Usina de origem",
  "Nº da(s) Nota(s) Fiscal(is) de USINA ",
  "Nº da Nota Fiscal de Remessa",
  "Estou ciente de que, após concluir o check-in, devo enviar a foto da NF de Usina para o WhatsApp da Line Transportes: (13) 99652-4561.",
  "Estou ciente de que o check-in confirma somente minha chegada à Baixada Santista, não garante posição ou ordem de descarga, e devo aguardar o contato da Line por telefone ou WhatsApp.",
  "Identificador de check-in"
] as const;

const RECORD = {
  identifier: "LT-23456789",
  startedAtIso: "2026-08-11T12:00:00.000Z",
  language: "pt-BR",
  email: "",
  name: "",
  driverName: "Motorista Teste",
  driverLicense: "12345678900",
  driverPhone: "13999999999",
  plate: "ABC1D23",
  carrierName: "Transportadora Teste",
  vehicleType: "Bitrem",
  product: "Produto Teste",
  originPlant: "Usina Teste",
  originInvoiceNumbers: "NF 123",
  remittanceInvoiceNumber: "NF 456",
  whatsappNoticeAccepted: "Ciente",
  queueLocationAccepted: "Ciente"
};
const REQUEST = {
  schemaVersion: "checkin-excel.v1",
  operation: "INCLUDE",
  idempotencyKey: RECORD.identifier,
  record: RECORD
};

class FakeTable {
  readonly rows: Array<Array<string | number | boolean>>;

  constructor(
    private readonly headers: readonly string[] = HEADERS,
    rows: Array<Array<string | number | boolean>> = []
  ) {
    this.rows = rows.map((row) => [...row]);
  }

  getName() {
    return "CheckinsV1";
  }

  getHeaderRowRange() {
    return { getTexts: () => [[...this.headers]] };
  }

  getRowCount() {
    return this.rows.length;
  }

  getRangeBetweenHeaderAndTotal() {
    return { getValues: () => this.rows.map((row) => [...row]) };
  }

  addRow(index: number, values: Array<string | number | boolean>) {
    if (index !== -1) throw new Error("O teste exige inclusão ao final.");
    this.rows.push([...values]);
  }
}

function loadMain() {
  const source = fs.readFileSync(SCRIPT_PATH, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
      strict: true
    }
  }).outputText;
  return new Function(`${compiled}; return main;`)() as (
    workbook: { getTable(name: string): FakeTable | undefined },
    requestJson: string
  ) => {
    identifier: string;
    confirmedAtIso: string;
    result: "CREATED" | "ALREADY_EXISTS";
  };
}

function workbookWith(table: FakeTable) {
  return {
    getTable(name: string) {
      return name === "CheckinsV1" ? table : undefined;
    }
  };
}

describe("Office Script de inclusão do Check-in V1", () => {
  it("versiona um schema compatível e um payload utilizável no gatilho HTTP", () => {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")) as {
      additionalProperties: boolean;
      required: string[];
      properties: {
        record: { additionalProperties: boolean; required: string[] };
      };
    };
    const sample = JSON.parse(fs.readFileSync(SAMPLE_PATH, "utf8"));

    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual([
      "schemaVersion",
      "operation",
      "idempotencyKey",
      "record"
    ]);
    expect(schema.properties.record.additionalProperties).toBe(false);
    expect(schema.properties.record.required).toHaveLength(17);
    // O gatilho HTTP do Power Automate rejeita `pattern` quando a validação do
    // schema está ativa. As invariantes de formato permanecem no Office Script.
    expect(JSON.stringify(schema)).not.toContain('"pattern"');
    expect(sample).toMatchObject({
      schemaVersion: "checkin-excel.v1",
      operation: "INCLUDE",
      idempotencyKey: sample.record.identifier
    });

    const table = new FakeTable();
    expect(loadMain()(workbookWith(table), JSON.stringify(sample)).result).toBe(
      "CREATED"
    );
    expect(table.rows).toHaveLength(1);
  });

  it("adiciona exatamente uma linha na ordem oficial e calcula o próximo Id", () => {
    const existing = [7, ...Array<string>(17).fill(""), "LT-ABCDEFGH"];
    const table = new FakeTable(HEADERS, [existing]);

    const result = loadMain()(workbookWith(table), JSON.stringify(REQUEST));

    expect(result).toMatchObject({
      identifier: "LT-23456789",
      result: "CREATED"
    });
    expect(result.confirmedAtIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[1]).toEqual([
      8,
      RECORD.startedAtIso,
      result.confirmedAtIso,
      "",
      "",
      "pt-BR",
      RECORD.driverName,
      RECORD.driverLicense,
      RECORD.driverPhone,
      RECORD.plate,
      RECORD.carrierName,
      RECORD.vehicleType,
      RECORD.product,
      RECORD.originPlant,
      RECORD.originInvoiceNumbers,
      RECORD.remittanceInvoiceNumber,
      "Ciente",
      "Ciente",
      RECORD.identifier
    ]);
  });

  it("repete o mesmo identificador sem adicionar uma segunda linha", () => {
    const table = new FakeTable();
    const main = loadMain();
    const workbook = workbookWith(table);

    expect(main(workbook, JSON.stringify(REQUEST)).result).toBe("CREATED");
    expect(main(workbook, JSON.stringify(REQUEST)).result).toBe(
      "ALREADY_EXISTS"
    );
    expect(table.rows).toHaveLength(1);
  });

  it("falha de forma fechada se a tabela já contiver duplicidade", () => {
    const duplicateRow = [
      1,
      ...Array<string>(17).fill(""),
      RECORD.identifier
    ];
    const table = new FakeTable(HEADERS, [duplicateRow, duplicateRow]);

    expect(() =>
      loadMain()(workbookWith(table), JSON.stringify(REQUEST))
    ).toThrow("CHECKIN_DUPLICADO_NA_PLANILHA");
    expect(table.rows).toHaveLength(2);
  });

  it("falha antes de escrever se os 19 cabeçalhos forem alterados", () => {
    const changedHeaders: string[] = [...HEADERS];
    changedHeaders[18] = "Código";
    const table = new FakeTable(changedHeaders);

    expect(() =>
      loadMain()(workbookWith(table), JSON.stringify(REQUEST))
    ).toThrow("CABECALHOS_CHECKIN_V1_INVALIDOS");
    expect(table.rows).toHaveLength(0);
  });

  it("neutraliza fórmulas mesmo se o chamador autenticado enviar texto inseguro", () => {
    const table = new FakeTable();
    const unsafeRecord = {
      ...RECORD,
      driverName: "=HYPERLINK(\"https://example.test\")"
    };

    loadMain()(
      workbookWith(table),
      JSON.stringify({
        ...REQUEST,
        record: unsafeRecord
      })
    );

    expect(table.rows[0]?.[6]).toBe("'=HYPERLINK(\"https://example.test\")");
  });

  it("rejeita chave idempotente diferente do identificador da visita", () => {
    const table = new FakeTable();

    expect(() =>
      loadMain()(
        workbookWith(table),
        JSON.stringify({ ...REQUEST, idempotencyKey: "LT-ABCDEFGH" })
      )
    ).toThrow("REQUISICAO_CHECKIN_V1_INVALIDA");
    expect(table.rows).toHaveLength(0);
  });
});
