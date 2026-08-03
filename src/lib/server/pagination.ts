import { createHash } from "node:crypto";
import { HttpError } from "@/lib/domain/errors";

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;
export const MAX_SCANNED_DOCUMENTS = 2000;
const MIN_FIRESTORE_TIMESTAMP_MILLIS = -62135596800000;
const MAX_FIRESTORE_TIMESTAMP_MILLIS = 253402300799999;

export type PaginationInput = {
  limit: number;
  cursor?: string;
};

type CursorValue = string | number | null;

type CursorPayload = {
  version: 1;
  kind: string;
  scope: string;
  values: CursorValue[];
  documentId: string;
};

type CursorValueType =
  | "string"
  | "number"
  | "nullable-number"
  | "timestamp-millis";

export function parsePagination(
  searchParams: URLSearchParams
): PaginationInput {
  const rawLimit = searchParams.get("limit");
  const rawCursor = searchParams.get("cursor");

  if (
    rawLimit !== null &&
    (!/^[1-9]\d*$/.test(rawLimit) ||
      Number(rawLimit) > MAX_PAGE_LIMIT)
  ) {
    throw new HttpError(
      400,
      `O limite deve ser um inteiro entre 1 e ${MAX_PAGE_LIMIT}.`
    );
  }
  if (rawCursor !== null && rawCursor.length === 0) {
    throw new HttpError(400, "Cursor de paginação inválido.");
  }

  return {
    limit: rawLimit === null ? DEFAULT_PAGE_LIMIT : Number(rawLimit),
    cursor: rawCursor ?? undefined
  };
}

export function paginationScope(
  kind: string,
  values: readonly unknown[]
): string {
  return createHash("sha256")
    .update(JSON.stringify([kind, ...values]))
    .digest("base64url")
    .slice(0, 24);
}

export function encodePaginationCursor(params: {
  kind: string;
  scope: string;
  values: CursorValue[];
  documentId: string;
}): string {
  const payload: CursorPayload = {
    version: 1,
    kind: params.kind,
    scope: params.scope,
    values: params.values,
    documentId: params.documentId
  };

  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function isCursorValueValid(
  value: CursorValue,
  expectedType: CursorValueType
): boolean {
  if (expectedType === "string") {
    return typeof value === "string";
  }
  if (expectedType === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (expectedType === "timestamp-millis") {
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= MIN_FIRESTORE_TIMESTAMP_MILLIS &&
      value <= MAX_FIRESTORE_TIMESTAMP_MILLIS
    );
  }
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function parseCursorPayload(cursor: string): Partial<CursorPayload> {
  if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new Error("invalid encoding");
  }

  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  if (Buffer.from(decoded, "utf8").toString("base64url") !== cursor) {
    throw new Error("non-canonical encoding");
  }
  return JSON.parse(decoded) as Partial<CursorPayload>;
}

export function decodePaginationCursor(params: {
  cursor: string;
  kind: string;
  scope: string;
  valueTypes: CursorValueType[];
}): {
  values: CursorValue[];
  documentId: string;
} {
  try {
    const payload = parseCursorPayload(params.cursor);
    const validDocumentId =
      typeof payload.documentId === "string" &&
      payload.documentId.length > 0 &&
      payload.documentId.length <= 1500 &&
      !payload.documentId.includes("/");
    const validValues =
      Array.isArray(payload.values) &&
      payload.values.length === params.valueTypes.length &&
      payload.values.every((value, index) =>
        isCursorValueValid(value, params.valueTypes[index])
      );

    if (
      payload.version !== 1 ||
      payload.kind !== params.kind ||
      payload.scope !== params.scope ||
      !validDocumentId ||
      !validValues
    ) {
      throw new Error("invalid payload");
    }

    return {
      values: payload.values as CursorValue[],
      documentId: payload.documentId as string
    };
  } catch {
    throw new HttpError(400, "Cursor de paginação inválido.");
  }
}

export async function scanFilteredPage<
  Document,
  Match,
  Position
>(params: {
  limit: number;
  batchSize: number;
  initialPosition: Position | null;
  fetchPage: (after: Position | null, limit: number) => Promise<Document[]>;
  positionForDocument: (document: Document) => Position;
  matchDocument: (document: Document) => Match | undefined;
  maxScannedDocuments?: number;
}): Promise<{
  matches: Match[];
  incomplete: boolean;
  lastScannedPosition: Position | null;
}> {
  const maxScanned =
    params.maxScannedDocuments ?? MAX_SCANNED_DOCUMENTS;
  const matches: Match[] = [];
  let scannedDocuments = 0;
  let scanPosition = params.initialPosition;

  while (
    matches.length <= params.limit &&
    scannedDocuments < maxScanned
  ) {
    const fetchLimit = Math.min(
      params.batchSize,
      maxScanned - scannedDocuments
    );
    const documents = await params.fetchPage(scanPosition, fetchLimit);
    scannedDocuments += documents.length;

    for (const document of documents) {
      const match = params.matchDocument(document);
      if (match !== undefined) {
        matches.push(match);
        if (matches.length > params.limit) break;
      }
    }

    const lastDocument = documents.at(-1);
    if (lastDocument) {
      scanPosition = params.positionForDocument(lastDocument);
    }
    if (matches.length > params.limit || documents.length < fetchLimit) {
      return {
        matches,
        incomplete: false,
        lastScannedPosition: scanPosition
      };
    }
  }

  return {
    matches,
    incomplete: matches.length <= params.limit,
    lastScannedPosition: scanPosition
  };
}
