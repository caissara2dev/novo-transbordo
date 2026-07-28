import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { z } from "zod";
import { HttpError } from "@/lib/domain/errors";
import { fail, ok, parseJsonBody } from "@/lib/server/http";

describe("HTTP response contract", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("wraps successful data and optional metadata", async () => {
    const response = ok(
      { items: [{ id: "event-1" }] },
      { status: 201, headers: { "x-request-id": "request-1" } },
      { nextCursor: "cursor-2" }
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("x-request-id")).toBe("request-1");
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: { items: [{ id: "event-1" }] },
      meta: { nextCursor: "cursor-2" }
    });
  });

  it.each([
    [400, "VALIDATION_ERROR"],
    [401, "UNAUTHENTICATED"],
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
    [409, "CONFLICT"],
    [429, "RATE_LIMITED"]
  ] as const)("maps status %s to the stable %s code", async (status, code) => {
    const response = fail(new HttpError(status, "Mensagem pública."));

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code,
        message: "Mensagem pública."
      }
    });
  });

  it("preserves an explicit error code", async () => {
    const response = fail(
      new HttpError(403, "Verifique seu e-mail antes de continuar.", {
        code: "EMAIL_UNVERIFIED"
      })
    );

    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: "EMAIL_UNVERIFIED",
        message: "Verifique seu e-mail antes de continuar."
      }
    });
  });

  it("returns validation details for schema errors without echoing submitted values", async () => {
    const schema = z.object({ approved: z.boolean() }).strict();
    const request = new NextRequest("http://localhost/api/users/u1/approve", {
      method: "POST",
      body: JSON.stringify({ approved: "false" })
    });

    let error: unknown;
    try {
      await parseJsonBody(request, schema);
    } catch (caught) {
      error = caught;
    }

    const response = fail(error);
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload).toMatchObject({
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Dados da requisição inválidos.",
        details: {
          fieldErrors: {
            approved: expect.any(Array)
          }
        }
      }
    });
    expect(JSON.stringify(payload)).not.toContain('"false"');
  });

  it("reports malformed JSON as a validation error", async () => {
    const request = new NextRequest("http://localhost/api/clients", {
      method: "POST",
      body: "{"
    });

    let error: unknown;
    try {
      await parseJsonBody(request, z.object({ name: z.string() }).strict());
    } catch (caught) {
      error = caught;
    }

    const response = fail(error);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Corpo da requisição inválido."
      }
    });
  });

  it("does not misclassify an unrelated SyntaxError as invalid request JSON", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = fail(new SyntaxError("Unexpected end of JSON input"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Erro inesperado."
      }
    });
    expect(consoleError).toHaveBeenCalledOnce();
  });

  it("allows an explicitly optional empty JSON body", async () => {
    const request = new NextRequest("http://localhost/api/auth/sync", {
      method: "POST"
    });

    await expect(
      parseJsonBody(
        request,
        z.object({ name: z.string().nullable().optional() }).strict(),
        { allowEmpty: true }
      )
    ).resolves.toEqual({});
  });

  it("propagates Retry-After for rate limit responses", async () => {
    const error = Object.assign(
      new HttpError(429, "Muitas requisições."),
      { retryAfterSeconds: 12 }
    );
    const response = fail(error);

    expect(response.headers.get("retry-after")).toBe("12");
  });

  it("returns an opaque 500 response for an unknown Error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = fail(new Error("secret database connection details"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Erro inesperado."
      }
    });
    expect(consoleError).toHaveBeenCalledOnce();
  });
});
