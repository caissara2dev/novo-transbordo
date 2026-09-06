import { HttpError } from "@/lib/domain/errors";
export { eventContainerStatus } from "@/lib/domain/container-effects";

export function containerDocumentKey(container: string): string {
  return container.replace(/[^A-Z0-9]/gi, "").toUpperCase();
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
