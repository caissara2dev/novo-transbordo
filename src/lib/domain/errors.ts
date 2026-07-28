export type HttpErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "EMAIL_UNVERIFIED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

export type HttpErrorOptions = {
  code?: HttpErrorCode;
  details?: unknown;
};

export function errorCodeForStatus(status: number): HttpErrorCode {
  if (status === 400 || status === 405 || status === 422) {
    return "VALIDATION_ERROR";
  }
  if (status === 401) {
    return "UNAUTHENTICATED";
  }
  if (status === 403) {
    return "FORBIDDEN";
  }
  if (status === 404) {
    return "NOT_FOUND";
  }
  if (status === 409) {
    return "CONFLICT";
  }
  if (status === 429) {
    return "RATE_LIMITED";
  }
  return "INTERNAL_ERROR";
}

export class HttpError extends Error {
  readonly status: number;
  readonly code?: HttpErrorCode;
  readonly details?: unknown;

  constructor(status: number, message: string, options: HttpErrorOptions = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = options.code;
    this.details = options.details;
  }
}
