import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = path.join(
  process.cwd(),
  "outputs/checkin-v1/power-automate/update-checkin.office-script.ts.txt"
);
const SCHEMA_PATH = path.join(
  process.cwd(),
  "outputs/checkin-v1/power-automate/update-request.schema.json"
);
const SAMPLE_PATH = path.join(
  process.cwd(),
  "outputs/checkin-v1/power-automate/update-request.sample.json"
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

const LEDGER_HEADERS = [
  "Idempotency key",
  "Identifier",
  "Payload SHA-256",
  "Confirmed at",
  "Result"
] as const;

const REQUEST = {
  schemaVersion: "checkin-excel.v1",
  operation: "UPDATE",
  idempotencyKey: "LT-23456789:v4",
  identifier: "LT-23456789",
  requestedAtIso: "2026-08-11T13:00:00.000Z",
  payloadHash:
    "7598390abba9a8d7a3b1c0cf1af764586392cea608821b4a22229037dd691ec0",
  patch: { plate: "BRA2E19" }
};

class FakeRange {
  constructor(private readonly table: FakeTable) {}

  getValues() {
    return this.table.rows.map((row) => [...row]);
  }

  getCell(rowIndex: number, columnIndex: number) {
    return {
      setValue: (value: string | number | boolean) => {
        const row = this.table.rows[rowIndex];
        if (!row) throw new Error("Linha inexistente no teste.");
        row[columnIndex] = value;
      }
    };
  }
}

class FakeTable {
  readonly rows: Array<Array<string | number | boolean>>;

  constructor(
    private name: string,
    private readonly headers: readonly string[],
    rows: Array<Array<string | number | boolean>> = []
  ) {
    this.rows = rows.map((row) => [...row]);
  }

  getName() {
    return this.name;
  }

  setName(name: string) {
    this.name = name;
  }

  getHeaderRowRange() {
    return {
      getTexts: () => [[...this.headers]],
      setValues: () => undefined
    };
  }

  getRowCount() {
    return this.rows.length;
  }

  getRangeBetweenHeaderAndTotal() {
    return new FakeRange(this);
  }

  addRow(index: number, values: Array<string | number | boolean>) {
    if (index !== -1) throw new Error("O teste exige inclusão ao final.");
    this.rows.push([...values]);
  }
}

class FakeWorkbook {
  checkins: FakeTable;
  ledger: FakeTable | undefined;

  constructor(rows: Array<Array<string | number | boolean>>) {
    this.checkins = new FakeTable("CheckinsV1", HEADERS, rows);
  }

  getTable(name: string) {
    if (name === "CheckinsV1") return this.checkins;
    if (name === "CheckinUpdateCommandsV1") return this.ledger;
    return undefined;
  }

  getWorksheet() {
    return undefined;
  }

  addWorksheet() {
    return {
      setVisibility: () => undefined,
      addTable: () => {
        this.ledger = new FakeTable(
          "CheckinUpdateCommandsV1",
          LEDGER_HEADERS
        );
        return this.ledger;
      }
    };
  }
}

function existingRow(identifier = "LT-23456789") {
  return [
    1,
    "2026-08-11T12:00:00.000Z",
    "2026-08-11T12:01:00.000Z",
    "",
    "",
    "pt-BR",
    "Motorista Teste",
    "12345678900",
    "13999999999",
    "ABC1D23",
    "Transportadora Teste",
    "Bitrem",
    "Produto Teste",
    "Usina Teste",
    "NF 123",
    "NF 456",
    "Ciente",
    "Ciente",
    identifier
  ];
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
  const excelScript = { SheetVisibility: { hidden: "Hidden" } };
  return new Function(
    "ExcelScript",
    `${compiled}; return main;`
  )(excelScript) as (
    workbook: FakeWorkbook,
    requestJson: string
  ) => {
    identifier: string;
    confirmedAtIso: string;
    result: "UPDATED" | "UNCHANGED";
  };
}

describe("Office Script de atualização do Check-in V1", () => {
  it("versiona um schema compatível e um exemplo com hash não sensível", () => {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")) as {
      additionalProperties: boolean;
      required: string[];
      properties: {
        patch: { additionalProperties: boolean };
      };
    };
    const sample = JSON.parse(fs.readFileSync(SAMPLE_PATH, "utf8"));

    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual([
      "schemaVersion",
      "operation",
      "idempotencyKey",
      "identifier",
      "requestedAtIso",
      "payloadHash",
      "patch"
    ]);
    expect(schema.properties.patch).toMatchObject({
      additionalProperties: false
    });
    expect(schema.properties.patch).not.toHaveProperty("minProperties");
    expect(JSON.stringify(schema)).not.toContain('"pattern"');
    expect(sample).toEqual(REQUEST);
  });

  it("atualiza somente a linha identificada e registra o comando idempotente", () => {
    const otherRow = existingRow("LT-ABCDEFGH");
    const workbook = new FakeWorkbook([otherRow, existingRow()]);

    const result = loadMain()(workbook, JSON.stringify(REQUEST));

    expect(result).toMatchObject({
      identifier: "LT-23456789",
      result: "UPDATED"
    });
    expect(workbook.checkins.rows[0]?.[9]).toBe("ABC1D23");
    expect(workbook.checkins.rows[1]?.[9]).toBe("BRA2E19");
    expect(workbook.ledger?.rows).toEqual([
      [
        REQUEST.idempotencyKey,
        REQUEST.identifier,
        REQUEST.payloadHash,
        result.confirmedAtIso,
        "UPDATED"
      ]
    ]);
  });

  it("repete o mesmo comando sem reaplicar a correção", () => {
    const workbook = new FakeWorkbook([existingRow()]);
    const main = loadMain();

    const first = main(workbook, JSON.stringify(REQUEST));
    workbook.checkins.rows[0]![9] = "ABC1D23";
    const replay = main(workbook, JSON.stringify(REQUEST));

    expect(replay).toEqual(first);
    expect(workbook.checkins.rows[0]?.[9]).toBe("ABC1D23");
    expect(workbook.ledger?.rows).toHaveLength(1);
  });

  it("rejeita a mesma chave idempotente com outro conteúdo", () => {
    const workbook = new FakeWorkbook([existingRow()]);
    const main = loadMain();
    main(workbook, JSON.stringify(REQUEST));

    expect(() =>
      main(
        workbook,
        JSON.stringify({
          ...REQUEST,
          payloadHash: "a".repeat(64),
          patch: { carrierName: "Outra transportadora" }
        })
      )
    ).toThrow("CHAVE_IDEMPOTENTE_REUTILIZADA");
    expect(workbook.checkins.rows[0]?.[10]).toBe("Transportadora Teste");
    expect(workbook.ledger?.rows).toHaveLength(1);
  });

  it("registra UNCHANGED quando a linha já possui os valores pedidos", () => {
    const row = existingRow();
    row[9] = "BRA2E19";
    const workbook = new FakeWorkbook([row]);

    const result = loadMain()(workbook, JSON.stringify(REQUEST));

    expect(result.result).toBe("UNCHANGED");
    expect(workbook.ledger?.rows[0]?.[4]).toBe("UNCHANGED");
  });

  it.each([
    ["inexistente", [existingRow("LT-ABCDEFGH")], "CHECKIN_NAO_ENCONTRADO"],
    [
      "duplicada",
      [existingRow(), existingRow()],
      "CHECKIN_DUPLICADO_NA_PLANILHA"
    ]
  ])("falha sem registrar comando quando a linha está %s", (_case, rows, error) => {
    const workbook = new FakeWorkbook(rows);

    expect(() =>
      loadMain()(workbook, JSON.stringify(REQUEST))
    ).toThrow(error);
    expect(workbook.ledger?.rows).toHaveLength(0);
  });

  it("rejeita campos fora da allowlist antes de alterar a linha", () => {
    const workbook = new FakeWorkbook([existingRow()]);

    expect(() =>
      loadMain()(
        workbook,
        JSON.stringify({ ...REQUEST, patch: { clientId: "cliente-1" } })
      )
    ).toThrow("ATUALIZACAO_CHECKIN_V1_INVALIDA");
    expect(workbook.checkins.rows[0]?.[9]).toBe("ABC1D23");
  });

  it("neutraliza fórmulas recebidas em campos textuais", () => {
    const workbook = new FakeWorkbook([existingRow()]);
    const request = {
      ...REQUEST,
      payloadHash: "b".repeat(64),
      patch: { driverName: "=HYPERLINK(\"https://example.test\")" }
    };

    loadMain()(workbook, JSON.stringify(request));

    expect(workbook.checkins.rows[0]?.[6]).toBe(
      "'=HYPERLINK(\"https://example.test\")"
    );
  });

  it("falha antes de escrever se os cabeçalhos oficiais forem alterados", () => {
    const workbook = new FakeWorkbook([existingRow()]);
    const headers: string[] = [...HEADERS];
    headers[18] = "Código";
    workbook.checkins = new FakeTable("CheckinsV1", headers, [existingRow()]);

    expect(() =>
      loadMain()(workbook, JSON.stringify(REQUEST))
    ).toThrow("CABECALHOS_CHECKIN_V1_INVALIDOS");
  });
});
