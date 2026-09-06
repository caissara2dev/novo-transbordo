import { Timestamp } from "firebase-admin/firestore";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EventDoc } from "@/types/domain";
import {
  buildContainerStateBackfillCandidates, buildContainerStateBackfillPatch, writeStates
} from "../../scripts/backfill-container-states.mjs";

process.env.CONTAINER_TRANSFERS_ENABLED = "true";
process.env.FIREBASE_PROJECT_ID = "demo-transbordo";

type AdminModule = typeof import("@/lib/firebase/admin");
type EventsService = typeof import("@/lib/server/events");
type GapsService = typeof import("@/lib/server/gaps");

let adminModule: AdminModule;
let eventsService: EventsService;
let gapsService: GapsService;

async function clearCollection(name: string): Promise<void> {
  const snapshot = await adminModule.adminDb.collection(name).get();
  const batch = adminModule.adminDb.batch();
  snapshot.docs.forEach((document) => batch.delete(document.ref));
  await batch.commit();
}

function event(overrides: Partial<EventDoc> = {}): EventDoc {
  return {
    pump: "BOMBA_1",
    shiftDate: "2026-07-27",
    shiftType: "MANHA",
    startTime: "06:00",
    endTime: "06:20",
    category: "PRODUTIVO",
    clientId: "client-1",
    plate: "ABC-1234",
    container: "ABCU 123456-0",
    containerStatus: "PARTIAL",
    containerReason: "Aguardando complemento",
    startsNewContainerCycle: false,
    blendConfirmed: false,
    notes: null,
    productive: true,
    origin: "MANUAL",
    generatedForEventId: null,
    gapSegmentId: null,
    justificationWaived: false,
    clientNameSnapshot: "Cliente",
    containerCycleId: "cycle-1",
    previousContainerEventId: null,
    containerStateVersion: 1,
    startAt: Timestamp.fromMillis(1_000),
    endAt: Timestamp.fromMillis(2_000),
    durationMinutes: 20,
    createdByUid: "operator",
    createdByEmail: "operator@example.com",
    updatedByUid: "operator",
    updatedByEmail: "operator@example.com",
    createdAt: Timestamp.fromMillis(1_100),
    updatedAt: Timestamp.fromMillis(1_100),
    deleted: false,
    deletedAt: null,
    deletedByUid: null,
    deletedByEmail: null,
    deletedReason: null,
    ...overrides
  };
}

describe("timeline transactions against the Firestore Emulator", () => {
  beforeAll(async () => {
    adminModule = await import("@/lib/firebase/admin");
    eventsService = await import("@/lib/server/events");
    gapsService = await import("@/lib/server/gaps");
  });

  beforeEach(async () => {
    await Promise.all(
      ["events", "timelineLocks", "containerStates", "clients", "settings"].map(
        clearCollection
      )
    );
  });

  it("revalidates a backfill scan after a retroactive edit and preserves its newer projection", async () => {
    const db = adminModule.adminDb;
    const source = event({ containerStatus: "PARTIAL" });
    const transfer = event({
      container: "MSCU 663987-0", containerStatus: "FULL",
      loadSourceType: "BUFFER_CONTAINER", sourceContainer: source.container,
      sourceContainerEmptied: false, sourceContainerCycleId: "cycle-1",
      previousSourceContainerEventId: "source", containerCycleId: "destination",
      endAt: Timestamp.fromMillis(3_000)
    });
    await db.collection("events").doc("source").set(source);
    await db.collection("events").doc("transfer").set(transfer);
    const scanned = buildContainerStateBackfillCandidates([
      { id: "source", data: source }, { id: "transfer", data: transfer }
    ]);
    const edited = { ...source, containerStatus: "BUFFER", updatedAt: Timestamp.now() };
    await db.collection("events").doc("source").set(edited);
    const fresh = buildContainerStateBackfillCandidates([
      { id: "source", data: edited }, { id: "transfer", data: transfer }
    ]).get("ABCU1234560")!;
    const current = { ...buildContainerStateBackfillPatch({ ...fresh, eventId: fresh.id, existing: undefined }), version: 9, updatedAt: Timestamp.now() };
    await db.collection("containerStates").doc("ABCU1234560").set(current);
    const before = await db.collection("events").get();
    await writeStates(db, scanned);
    expect((await db.collection("containerStates").doc("ABCU1234560").get()).data()).toEqual(current);
    expect((await db.collection("events").get()).docs.map((doc) => doc.data())).toEqual(before.docs.map((doc) => doc.data()));
    expect(await writeStates(db, scanned)).toEqual({ writes: 0, skipped: 2 });
  });

  it("does not resurrect a state when its event was deleted after the backfill scan", async () => {
    const db = adminModule.adminDb;
    const data = event();
    const scanned = buildContainerStateBackfillCandidates([{ id: "source", data }]);
    await db.collection("events").doc("source").set({ ...data, deleted: true });
    expect(await writeStates(db, scanned)).toEqual({ writes: 0, skipped: 1 });
    expect((await db.collection("containerStates").get()).empty).toBe(true);
  });

  it("allows only one concurrent command to claim the same empty interval", async () => {
    const input = {
      pump: "BOMBA_1",
      shiftDate: "2026-07-27",
      shiftType: "MANHA",
      startTime: "06:00",
      endTime: "06:10",
      category: "OUTROS",
      clientId: null,
      plate: null,
      container: null,
      containerStatus: null,
      containerReason: null,
      startsNewContainerCycle: false,
      blendConfirmed: false,
      expectedContainerStateVersion: null,
      notes: "Preparação operacional"
    };

    const results = await Promise.allSettled([
      eventsService.createEvent(input, {
        uid: "operator-1",
        email: "one@example.com"
      }),
      eventsService.createEvent(input, {
        uid: "operator-2",
        email: "two@example.com"
      })
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected")
    ).toHaveLength(1);

    const events = await adminModule.adminDb.collection("events").get();
    const lock = await adminModule.adminDb
      .collection("timelineLocks")
      .doc("2026-07-27_MANHA_BOMBA_1")
      .get();
    expect(events.docs).toHaveLength(1);
    expect(lock.data()?.version).toBe(1);
  });

  it.each(["BUFFER", "PARTIAL"] as const)(
    "allows only one concurrent transfer to consume the same %s source version",
    async (sourceStatus) => {
      const sourceContainer = "MSCU 663987-0";
      const sourceEvent = event({
        shiftDate: "2026-07-26",
        shiftType: "NOITE",
        startTime: "05:49",
        endTime: "05:59",
        startAt: Timestamp.fromDate(new Date("2026-07-27T08:49:00.000Z")),
        durationMinutes: 10,
        container: sourceContainer,
        containerStatus: sourceStatus,
        containerReason: "Reserva operacional",
        containerCycleId: "cycle-source",
        endAt: Timestamp.fromDate(new Date("2026-07-27T08:59:00.000Z")),
        createdAt: Timestamp.fromDate(new Date("2026-07-27T08:59:10.000Z"))
      });
      await Promise.all([
        adminModule.adminDb.collection("clients").doc("client-1").set({
          name: "Cliente",
          nameUpper: "CLIENTE",
          active: true
        }),
        adminModule.adminDb
          .collection("events")
          .doc("source-buffer")
          .set(sourceEvent),
        adminModule.adminDb
          .collection("containerStates")
          .doc("MSCU6639870")
          .set({
            container: sourceContainer,
            status: sourceStatus,
            reason: "Reserva operacional",
            cycleId: "cycle-source",
            latestEventId: "source-buffer",
            previousEventId: null,
            clientId: "client-1",
            clientNameSnapshot: "Cliente",
            plate: "ABC-1234",
            pump: "BOMBA_1",
            operationalAt: sourceEvent.endAt,
            eventCreatedAt: sourceEvent.createdAt,
            version: 4,
            updatedAt: sourceEvent.createdAt
          })
      ]);

      const baseInput = {
        shiftDate: "2026-07-27",
        shiftType: "MANHA" as const,
        startTime: "06:00",
        endTime: "06:10",
        category: "PRODUTIVO" as const,
        clientId: "client-1",
        plate: null,
        containerStatus: "FULL" as const,
        containerReason: null,
        startsNewContainerCycle: false,
        blendConfirmed: false,
        expectedContainerStateVersion: 0,
        loadSourceType: "BUFFER_CONTAINER" as const,
        sourceContainer,
        sourceContainerEmptied: false,
        expectedSourceContainerStateVersion: 4,
        notes: null
      };
      const first = {
        ...baseInput,
        pump: "BOMBA_1" as const,
        container: "ABCU 123456-0"
      };
      const second = {
        ...baseInput,
        pump: "BOMBA_2" as const,
        container: "MATU 765432-1"
      };
      const [firstGap, secondGap] = await Promise.all([
        gapsService.previewEventGap(first),
        gapsService.previewEventGap(second)
      ]);

      const results = await Promise.allSettled([
        eventsService.createEvent(
          { ...first, gapVersion: firstGap.gapVersion },
          {
            uid: "operator-1",
            email: "one@example.com"
          }
        ),
        eventsService.createEvent(
          { ...second, gapVersion: secondGap.gapVersion },
          {
            uid: "operator-2",
            email: "two@example.com"
          }
        )
      ]);

      expect(
        results.filter((result) => result.status === "fulfilled")
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "rejected")
      ).toHaveLength(1);
      const productive = await adminModule.adminDb
        .collection("events")
        .where("loadSourceType", "==", "BUFFER_CONTAINER")
        .get();
      expect(productive.docs).toHaveLength(1);
      const sourceState = await adminModule.adminDb
        .collection("containerStates")
        .doc("MSCU6639870")
        .get();
      expect(sourceState.data()).toMatchObject({
        status: sourceStatus,
        version: 5
      });
    }
  );
});
