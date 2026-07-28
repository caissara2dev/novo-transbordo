"use client";

import { getToken } from "firebase/app-check";
import {
  errorCodeForStatus,
  HttpErrorCode
} from "@/lib/domain/errors";
import { appCheck, auth } from "@/lib/firebase/client";

type ApiSuccess<T> = {
  ok: true;
  data: T;
  meta?: unknown;
};

type ApiFailure = {
  ok: false;
  error: {
    code: HttpErrorCode;
    message: string;
    details?: unknown;
  };
};

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: HttpErrorCode;
  readonly details?: unknown;

  constructor(params: {
    status: number;
    code: HttpErrorCode;
    message: string;
    details?: unknown;
  }) {
    super(params.message);
    this.name = "ApiRequestError";
    this.status = params.status;
    this.code = params.code;
    this.details = params.details;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSuccessEnvelope<T>(value: unknown): value is ApiSuccess<T> {
  return (
    isRecord(value) &&
    value.ok === true &&
    Object.prototype.hasOwnProperty.call(value, "data")
  );
}

function isFailureEnvelope(value: unknown): value is ApiFailure {
  if (!isRecord(value) || value.ok !== false || !isRecord(value.error)) {
    return false;
  }

  return (
    typeof value.error.code === "string" &&
    typeof value.error.message === "string"
  );
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("A operação foi cancelada.", "AbortError");
}

async function getAppCheckToken(): Promise<{ token: string } | undefined> {
  if (!appCheck) {
    return undefined;
  }

  try {
    return await getToken(appCheck);
  } catch (error) {
    if (process.env.NEXT_PUBLIC_APP_CHECK_FAIL_CLOSED === "true") {
      throw error;
    }

    return undefined;
  }
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) {
    return operation;
  }

  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });

    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

export async function authenticatedFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const user = auth.currentUser;

  if (!user) {
    throw new Error("Usuário não autenticado.");
  }

  if (init?.signal?.aborted) {
    throw abortReason(init.signal);
  }

  const [token, appCheckResult] = await abortable(
    Promise.all([
      user.getIdToken(),
      getAppCheckToken()
    ]),
    init?.signal
  );
  const headers = new Headers(init?.headers);

  headers.set("Authorization", `Bearer ${token}`);
  if (appCheckResult?.token) {
    headers.set("X-Firebase-AppCheck", appCheckResult.token);
  }

  return fetch(input, {
    ...init,
    headers
  });
}

export async function apiFetch<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);

  if (typeof init?.body === "string" && !headers.has("content-type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await authenticatedFetch(input, {
    ...init,
    headers
  });

  return readApiResponse<T>(response);
}

export async function readApiResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null);

  if (isFailureEnvelope(payload)) {
    throw new ApiRequestError({
      status: response.status,
      code: payload.error.code,
      message: payload.error.message,
      details: payload.error.details
    });
  }

  if (!response.ok) {
    throw new ApiRequestError({
      status: response.status,
      code: errorCodeForStatus(response.status),
      message: "Erro de requisição."
    });
  }

  if (!isSuccessEnvelope<T>(payload)) {
    throw new ApiRequestError({
      status: response.status,
      code: "INTERNAL_ERROR",
      message: "Resposta inválida do servidor."
    });
  }

  return payload.data;
}
