import { describe, expect, it } from "vitest";
import {
  buildRestoreRequestPayload,
  buildGapJustificationsByEvent,
  isRestorePreviewConflict
} from "@/lib/ui/event-reconciliation";
import { GapJustification, GapPreview } from "@/types/domain";

const requiredPreview = (
  eventId: string,
  segmentId: string
): NonNullable<GapPreview["reconciliations"]>[number] => ({
  eventId,
  preview: {
    toleranceMinutes: 10,
    gapVersion: `${eventId}-v1`,
    uncoveredSegments: [
      {
        id: segmentId,
        startTime: "09:00",
        endTime: "09:30",
        durationMinutes: 30
      }
    ],
    uncoveredMinutes: 30,
    requiresJustification: true
  }
});

describe("event reconciliation UI", () => {
  it("creates one editable justification list per affected event", () => {
    const result = buildGapJustificationsByEvent([
      requiredPreview("event-a", "segment-a"),
      requiredPreview("event-b", "segment-b")
    ]);

    expect(result).toEqual({
      "event-a": [
        {
          id: "segment-a",
          startTime: "09:00",
          endTime: "09:30",
          durationMinutes: 30,
          category: "OUTROS",
          clientId: null,
          plate: null,
          notes: null
        }
      ],
      "event-b": [
        {
          id: "segment-b",
          startTime: "09:00",
          endTime: "09:30",
          durationMinutes: 30,
          category: "OUTROS",
          clientId: null,
          plate: null,
          notes: null
        }
      ]
    });
  });

  it("preserves a user's matching justification when a preview is refreshed", () => {
    const previous: Record<string, GapJustification[]> = {
      "event-a": [
        {
          id: "segment-a",
          startTime: "09:00",
          endTime: "09:30",
          durationMinutes: 30,
          category: "MANUTENCAO",
          clientId: null,
          plate: null,
          notes: "Parada programada"
        }
      ]
    };

    expect(
      buildGapJustificationsByEvent(
        [requiredPreview("event-a", "segment-a")],
        previous
      )
    ).toEqual(previous);
  });

  it("recognizes the restore conflict that requires a fresh preview", () => {
    expect(
      isRestorePreviewConflict(
        new Error("A linha do tempo mudou depois da prévia de restauração.")
      )
    ).toBe(true);
    expect(
      isRestorePreviewConflict(
        Object.assign(new Error("O container mudou."), { status: 409 })
      )
    ).toBe(true);
    expect(isRestorePreviewConflict(new Error("Usuário não autenticado."))).toBe(
      false
    );
  });

  it("uses the current container version returned by the restore preview", () => {
    expect(
      buildRestoreRequestPayload(
        {
          gapVersion: "restore-v4",
          changedSinceDeletion: true,
          expectedContainerStateVersion: 12,
          reconciliations: []
        },
        {}
      )
    ).toEqual({
      gapVersion: "restore-v4",
      gapJustificationsByEvent: {},
      expectedContainerStateVersion: 12
    });
  });
});
