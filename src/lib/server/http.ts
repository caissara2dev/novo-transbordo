import { NextResponse } from "next/server";
import { z } from "zod";
import {
  errorCodeForStatus,
  HttpError,
  HttpErrorCode
} from "@/lib/domain/errors";

type SuccessResponseInit = ResponseInit & {
  meta?: unknown;
};

type RetryableError = {
  retryAfterSeconds?: unknown;
};

function normalizeSuccessInit(
  init: number | SuccessResponseInit | undefined
): { responseInit: ResponseInit; embeddedMeta: unknown } {
  if (typeof init === "number") {
    return {
      responseInit: { status: init },
      embeddedMeta: undefined
    };
  }

  const { meta, ...responseInit } = init ?? {};
  return {
    responseInit: {
      status: 200,
      ...responseInit
    },
    embeddedMeta: meta
  };
}

export function ok(
  data: unknown,
  init?: number | SuccessResponseInit,
  meta?: unknown
): NextResponse {
  const normalized = normalizeSuccessInit(init);
  const responseMeta =
    meta === undefined ? normalized.embeddedMeta : meta;

  return NextResponse.json(
    {
      ok: true,
      data,
      ...(responseMeta === undefined ? {} : { meta: responseMeta })
    },
    normalized.responseInit
  );
}

function retryAfterHeader(error: unknown): Headers | undefined {
  const retryAfterSeconds = (error as RetryableError | null)?.retryAfterSeconds;
  if (
    typeof retryAfterSeconds !== "number" ||
    !Number.isFinite(retryAfterSeconds) ||
    retryAfterSeconds <= 0
  ) {
    return undefined;
  }

  const headers = new Headers();
  headers.set("Retry-After", String(Math.ceil(retryAfterSeconds)));
  return headers;
}

function errorResponse(params: {
  status: number;
  code: HttpErrorCode;
  message: string;
  details?: unknown;
  headers?: Headers;
}): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: params.code,
        message: params.message,
        ...(params.details === undefined ? {} : { details: params.details })
      }
    },
    {
      status: params.status,
      headers: params.headers
    }
  );
}

export function fail(error: unknown): NextResponse {
  if (error instanceof z.ZodError) {
    return errorResponse({
      status: 400,
      code: "VALIDATION_ERROR",
      message: "Dados da requisição inválidos.",
      details: error.flatten()
    });
  }

  if (error instanceof HttpError) {
    const status =
      Number.isInteger(error.status) &&
      error.status >= 400 &&
      error.status <= 599
        ? error.status
        : 500;
    const internal = status >= 500;

    if (internal) {
      console.error("Erro interno tratado pela API.", error);
    }

    return errorResponse({
      status,
      code: internal
        ? "INTERNAL_ERROR"
        : error.code ?? errorCodeForStatus(status),
      message: internal ? "Erro inesperado." : error.message,
      details: internal ? undefined : error.details,
      headers: retryAfterHeader(error)
    });
  }

  console.error("Erro não tratado pela API.", error);
  return errorResponse({
    status: 500,
    code: "INTERNAL_ERROR",
    message: "Erro inesperado."
  });
}

export async function parseJsonBody<T>(
  request: Request,
  schema: z.ZodType<T>,
  options: { allowEmpty?: boolean } = {}
): Promise<T> {
  const raw = await request.text();
  let input: unknown;

  if (!raw.trim()) {
    if (!options.allowEmpty) {
      throw new HttpError(400, "Corpo da requisição inválido.");
    }
    input = {};
  } else {
    try {
      input = JSON.parse(raw) as unknown;
    } catch {
      throw new HttpError(400, "Corpo da requisição inválido.");
    }
  }

  return schema.parse(input);
}
