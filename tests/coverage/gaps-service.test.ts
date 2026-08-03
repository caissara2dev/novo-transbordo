import { Timestamp } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { inMemoryAdminDb } from "./in-memory-firestore";

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: inMemoryAdminDb
}));

import {
  loadTimeline,
  parseGapPreviewInput,
  prepareDeletionGap,
  prepareFollowingGapsAfterOverride,
  previewEventGap,
  previewGapAfterEventOverride,
  timelineLockId,
  timelineLockRef
} from "@/lib/server/gaps";
import { resolveTimelineDate } from "@/lib/domain/time";
import { EventDoc } from "@/types/domain";

function at(time: string): Timestamp {
  return Timestamp.fromDate(
    resolveTimelineDate("2026-07-27", "MANHA", time).toJSDate()
  );
}

function timelineEvent(
  overrides: Partial<EventDoc> = {}
): EventDoc {
  return {
    pump: "BOMBA_1",
    shiftDate: "2026-07-27",
    shiftType: "MANHA",
    startTime: "06:00",
    endTime: "06:20",
    category: "PRODUTIVO",
    clientId: "client-1",
    plate: "ABC-1234",
    container: null,
    containerStatus: null,
    containerReason: null,
    startsNewContainerCycle: false,
    blendConfirmed: false,
    notes: null,
    productive: true,
    origin: "MANUAL",
    generatedForEventId: null,
    gapSegmentId: null,
    justificationWaived: false,
    clientNameSnapshot: "Cliente",
    containerCycleId: null,
    previousContainerEventId: null,
    containerStateVersion: null,
    startAt: at("06:00"),
    endAt: at("06:20"),
    durationMinutes: 20,
    createdByUid: "operator",
    createdByEmail: "operator@example.com",
    updatedByUid: "operator",
    updatedByEmail: "operator@example.com",
    createdAt: at("06:20"),
    updatedAt: at("06:20"),
    deleted: false,
    deletedAt: null,
    deletedByUid: null,
    deletedByEmail: null,
    deletedReason: null,
    ...overrides
  };
}

describe("public automatic gap service", () => {
  beforeEach(() => {
    inMemoryAdminDb.reset();
    inMemoryAdminDb.seed("settings", "operations", {
      idleToleranceMinutes: 10
    });
    inMemoryAdminDb.seed(
      "timelineLocks",
      timelineLockId("2026-07-27", "MANHA", "BOMBA_1"),
      { version: 3 }
    );
  });

  it("parses the command boundary and exposes a stable lock reference", () => {
    expect(
      parseGapPreviewInput({
        pump: "BOMBA_1",
        shiftDate: "2026-07-27",
        shiftType: "MANHA",
        startTime: "06:30"
      })
    ).toMatchObject({ startTime: "06:30" });
    expect(
      timelineLockRef("2026-07-27", "MANHA", "BOMBA_1").path
    ).toBe("timelineLocks/2026-07-27_MANHA_BOMBA_1");
    expect(() =>
      parseGapPreviewInput({
        pump: "BOMBA_1",
        shiftDate: "2026-07-27",
        shiftType: "MANHA",
        startTime: "25:00"
      })
    ).toThrow("Horário de início inválido");
  });

  it("loads only the requested pump and shift while preserving legacy productivity", async () => {
    inMemoryAdminDb.seed("events", "productive", timelineEvent());
    inMemoryAdminDb.seed(
      "events",
      "legacy",
      timelineEvent({
        category: "PRODUTIVO",
        productive: undefined as never,
        startAt: { _seconds: at("06:30").seconds },
        endAt: { _seconds: at("06:40").seconds },
        updatedAt: { _seconds: at("06:40").seconds }
      }) as unknown as Record<string, unknown>
    );
    inMemoryAdminDb.seed(
      "events",
      "other-pump",
      timelineEvent({ pump: "BOMBA_2" }) as unknown as Record<string, unknown>
    );
    inMemoryAdminDb.seed(
      "events",
      "other-shift",
      timelineEvent({ shiftType: "NOITE" }) as unknown as Record<string, unknown>
    );

    const timeline = await loadTimeline({
      shiftDate: "2026-07-27",
      shiftType: "MANHA",
      pump: "BOMBA_1"
    });
    expect(timeline.map((entry) => entry.id)).toEqual([
      "legacy",
      "productive"
    ]);
    expect(timeline.every((entry) => entry.productive)).toBe(true);
  });

  it("previews a first-event gap and rejects an overlapping start", async () => {
    const first = await previewEventGap({
      pump: "BOMBA_1",
      shiftDate: "2026-07-27",
      shiftType: "MANHA",
      startTime: "06:11"
    });
    expect(first).toMatchObject({
      toleranceMinutes: 10,
      uncoveredMinutes: 11,
      requiresJustification: true
    });

    inMemoryAdminDb.seed(
      "events",
      "existing",
      timelineEvent({
        startTime: "06:00",
        endTime: "07:00",
        startAt: at("06:00"),
        endAt: at("07:00")
      }) as unknown as Record<string, unknown>
    );
    await expect(
      previewEventGap({
        pump: "BOMBA_1",
        shiftDate: "2026-07-27",
        shiftType: "MANHA",
        startTime: "06:30"
      })
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rejects deletion preview without an event and reports missing targets", async () => {
    await expect(
      previewEventGap({
        pump: "BOMBA_1",
        shiftDate: "2026-07-27",
        shiftType: "MANHA",
        startTime: "06:00",
        operation: "DELETE"
      })
    ).rejects.toMatchObject({ status: 400 });
    await expect(prepareDeletionGap("missing")).rejects.toMatchObject({
      status: 404
    });
  });

  it("simulates an override and removes its generated gaps from coverage", async () => {
    const target = timelineEvent({
      startTime: "07:00",
      endTime: "07:20",
      startAt: at("07:00"),
      endAt: at("07:20")
    });
    const override = timelineEvent({
      startTime: "06:00",
      endTime: "06:45",
      startAt: at("06:00"),
      endAt: at("06:45")
    });
    inMemoryAdminDb.seed("events", "target", target as unknown as Record<string, unknown>);
    inMemoryAdminDb.seed(
      "events",
      "old",
      timelineEvent() as unknown as Record<string, unknown>
    );
    inMemoryAdminDb.seed(
      "events",
      "generated",
      timelineEvent({
        productive: false,
        origin: "AUTO_GAP",
        generatedForEventId: "old",
        category: "INTERVALO_OPERACIONAL",
        startAt: at("06:20"),
        endAt: at("07:00")
      }) as unknown as Record<string, unknown>
    );

    const preview = await previewGapAfterEventOverride({
      targetId: "target",
      target,
      overrideId: "old",
      override
    });
    expect(preview.uncoveredSegments).toEqual([
      expect.objectContaining({ startTime: "06:45", endTime: "07:00" })
    ]);
  });

  it("finds and deduplicates following productive events across old and new timelines", async () => {
    const existing = timelineEvent();
    const override = timelineEvent({
      startTime: "06:05",
      endTime: "06:25",
      startAt: at("06:05"),
      endAt: at("06:25")
    });
    inMemoryAdminDb.seed(
      "events",
      "next",
      timelineEvent({
        startTime: "07:00",
        endTime: "07:20",
        startAt: at("07:00"),
        endAt: at("07:20")
      }) as unknown as Record<string, unknown>
    );

    const following = await prepareFollowingGapsAfterOverride({
      eventId: "edited",
      existing,
      override
    });
    expect(following).toHaveLength(1);
    expect(following[0]).toMatchObject({
      target: { id: "next" },
      preview: {
        uncoveredMinutes: 35,
        uncoveredSegments: [
          expect.objectContaining({ startTime: "06:25", endTime: "07:00" })
        ]
      }
    });
  });

  it("previews deletion with and without a following productive target", async () => {
    inMemoryAdminDb.seed(
      "events",
      "first",
      timelineEvent() as unknown as Record<string, unknown>
    );

    const terminal = await prepareDeletionGap("first");
    expect(terminal.target).toBeNull();
    expect(terminal.preview).toMatchObject({
      uncoveredSegments: [],
      uncoveredMinutes: 0,
      requiresJustification: false,
      reconciliationEventId: null
    });

    inMemoryAdminDb.seed(
      "events",
      "next",
      timelineEvent({
        startTime: "07:00",
        endTime: "07:20",
        startAt: at("07:00"),
        endAt: at("07:20")
      }) as unknown as Record<string, unknown>
    );
    const withTarget = await prepareDeletionGap("first");
    expect(withTarget.target?.id).toBe("next");
    expect(withTarget.preview.reconciliationEventId).toBe("next");
    expect(withTarget.preview.uncoveredMinutes).toBe(60);
  });

  it("updates an existing preview and includes the next-event reconciliation version", async () => {
    inMemoryAdminDb.seed(
      "events",
      "edited",
      timelineEvent() as unknown as Record<string, unknown>
    );
    inMemoryAdminDb.seed(
      "events",
      "next",
      timelineEvent({
        startTime: "07:00",
        endTime: "07:20",
        startAt: at("07:00"),
        endAt: at("07:20")
      }) as unknown as Record<string, unknown>
    );

    const preview = await previewEventGap({
      pump: "BOMBA_1",
      shiftDate: "2026-07-27",
      shiftType: "MANHA",
      startTime: "06:05",
      endTime: "06:25",
      eventId: "edited"
    });
    expect(preview.reconciliations).toEqual([
      expect.objectContaining({ eventId: "next" })
    ]);

    await expect(
      previewEventGap({
        pump: "BOMBA_1",
        shiftDate: "2026-07-27",
        shiftType: "MANHA",
        startTime: "08:00",
        eventId: "missing"
      })
    ).rejects.toMatchObject({ status: 404 });
  });
});
