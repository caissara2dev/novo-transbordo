import { DocumentData } from "firebase-admin/firestore";
import { HttpError } from "@/lib/domain/errors";
import { ContainerStatus, containerStatuses } from "@/types/domain";

export function containerDocumentKey(container: string): string {
  return container.replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

export function eventContainerStatus(data: DocumentData): ContainerStatus | null {
  const raw = data.containerStatus;
  if (containerStatuses.includes(raw as ContainerStatus)) {
    return raw as ContainerStatus;
  }

  if (data.category === "PRODUTIVO" && data.container) {
    return "FULL";
  }

  return null;
}

export function assertExpectedContainerStateVersion(
  expectedVersion: number | null,
  observedVersion: number
): void {
  if (expectedVersion !== null && expectedVersion !== observedVersion) {
    throw new HttpError(
      409,
      "O estado deste container foi alterado por outro usuário. Atualize e tente novamente."
    );
  }
}
