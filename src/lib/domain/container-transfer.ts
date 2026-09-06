import type { ContainerStatus, LoadSourceType } from "../../types/domain.ts";

export const TRANSFER_SOURCE_STATUSES: ContainerStatus[] = [
  "BUFFER",
  "PARTIAL"
];

export function isTransferSourceStatus(
  status: unknown
): status is "BUFFER" | "PARTIAL" {
  return status === "BUFFER" || status === "PARTIAL";
}

export function originCode(value: string): string {
  return value.replace(/[\s-]/g, "").toUpperCase();
}

export function identifyLoadSource(value: string): LoadSourceType | null {
  const code = originCode(value);
  if (/^[A-Z]{4}/.test(code)) return "BUFFER_CONTAINER";
  if (/^[A-Z]{3}\d/.test(code)) return "TRUCK";
  return null;
}
