import { NextResponse } from "next/server";
import { HttpError } from "@/lib/domain/errors";

export function ok(data: unknown, init?: number): NextResponse {
  return NextResponse.json(data, { status: init ?? 200 });
}

export function fail(error: unknown): NextResponse {
  if (error instanceof HttpError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  if (error instanceof Error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ error: "Erro inesperado." }, { status: 500 });
}
