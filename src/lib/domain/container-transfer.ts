import { HttpError } from "./errors.ts";
import type {
  ContainerLifecycleStatus,
  ContainerStatus,
  LoadSourceType
} from "../../types/domain.ts";

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

export function resolveTransferSourceStatus(params: {
  previousStatus: ContainerLifecycleStatus;
  previousClientId: string;
  clientId: string;
  emptied: boolean;
}): "BUFFER" | "PARTIAL" | "TRANSFER_EMPTIED" {
  if (!isTransferSourceStatus(params.previousStatus)) {
    throw new HttpError(
      409,
      "O container de origem não está mais aberto como Pulmão ou Parcial."
    );
  }
  if (params.previousClientId !== params.clientId) {
    throw new HttpError(
      400,
      "A origem e o destino devem pertencer ao mesmo cliente."
    );
  }
  return params.emptied ? "TRANSFER_EMPTIED" : params.previousStatus;
}

export function assertTransferSourceCycleMatches(
  selectedCycleId: string | null,
  resolvedCycleId: string | null
): void {
  if (selectedCycleId && selectedCycleId !== resolvedCycleId) {
    throw new HttpError(
      409,
      "O horário da transferência não pertence ao ciclo de origem selecionado. Atualize a origem e confira o horário antes de confirmar novamente."
    );
  }
}
