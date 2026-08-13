import { GapJustification, GapPreview } from "@/types/domain";
import { RestoreEventPreviewResponse } from "@/types/api";

type GapReconciliationPreview =
  NonNullable<GapPreview["reconciliations"]>[number];

export function buildRestoreRequestPayload(
  preview: RestoreEventPreviewResponse,
  gapJustificationsByEvent: Record<string, GapJustification[]>
) {
  return {
    gapVersion: preview.gapVersion,
    gapJustificationsByEvent,
    expectedContainerStateVersion: preview.expectedContainerStateVersion,
    expectedSourceContainerStateVersion:
      preview.expectedSourceContainerStateVersion ?? null
  };
}

export function isRestorePreviewConflict(
  error: unknown
): error is Error & { status?: number } {
  return (
    error instanceof Error &&
    ((error as Error & { status?: number }).status === 409 ||
      error.message.toLocaleLowerCase("pt-BR").includes("linha do tempo mudou"))
  );
}

export function buildGapJustificationsByEvent(
  reconciliations: GapReconciliationPreview[],
  previous: Record<string, GapJustification[]> = {}
): Record<string, GapJustification[]> {
  return Object.fromEntries(
    reconciliations.flatMap(({ eventId, preview }) => {
      if (!preview.requiresJustification) {
        return [];
      }

      const previousById = new Map(
        (previous[eventId] || []).map((item) => [item.id, item])
      );
      const justifications = preview.uncoveredSegments.map((segment) => {
        const existing = previousById.get(segment.id);

        return {
          ...segment,
          category: existing?.category || "OUTROS",
          clientId: existing?.clientId || null,
          plate: existing?.plate || null,
          notes: existing?.notes || null
        } satisfies GapJustification;
      });

      return [[eventId, justifications]];
    })
  );
}
