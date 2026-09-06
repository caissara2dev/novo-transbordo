import "server-only";
import { HttpError } from "@/lib/domain/errors";

export function containerTransfersEnabled(): boolean {
  return process.env.CONTAINER_TRANSFERS_ENABLED === "true";
}

export function assertContainerTransfersEnabled(): void {
  if (!containerTransfersEnabled()) {
    throw new HttpError(
      409,
      "Transferências entre containers estão temporariamente indisponíveis. Os históricos continuam disponíveis."
    );
  }
}
