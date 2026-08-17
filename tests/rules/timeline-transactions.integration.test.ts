import { Timestamp } from "firebase-admin/firestore";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EventDoc } from "@/types/domain";

process.env.FIREBASE_PROJECT_ID = "demo-transbordo";

type AdminModule = typeof import("@/lib/firebase/admin");
type EventsService = typeof import("@/lib/server/events");
type GapService = typeof import("@/lib/server/gaps");

let adminModule: AdminModule;
let eventsService: EventsService;
let gapService: GapService;

async function clearCollection(name: string): Promise<void> {
  const snapshot = await adminModule.adminDb.collection(name).get();
  const batch = adminModule.adminDb.batch();
  snapshot.docs.forEach((document) => batch.delete(document.ref));
  await batch.commit();
}

function event(
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
    gapService = await import("@/lib/server/gaps");
  });

  beforeEach(async () => {
    process.env.CHECKIN_INTEGRATION_MODE = "off";
    process.env.CHECKIN_INTEGRATION_KEY_ID = "checkin-v1";
    process.env.CHECKIN_INTEGRATION_HMAC_SECRET = "a".repeat(32);
    process.env.CHECKIN_INDEX_HMAC_SECRET = "b".repeat(32);
    process.env.CHECKIN_GEOFENCE_CENTER_LAT = "-23.9608";
    process.env.CHECKIN_GEOFENCE_CENTER_LNG = "-46.3336";
    await Promise.all(
      [
        "events",
        "timelineLocks",
        "containerStates",
        "clients",
        "checkins",
        "settings"
      ].map(clearCollection)
    );
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
        email: "one@example.com",
        role: "OPERATOR"
      }),
      eventsService.createEvent(input, {
        uid: "operator-2",
        email: "two@example.com",
        role: "OPERATOR"
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

  it("allows only one concurrent productive event to claim a called check-in", async () => {
    process.env.CHECKIN_INTEGRATION_MODE = "observe";
    const checkInId = "11111111-1111-4111-8111-111111111111";
    await Promise.all([
      adminModule.adminDb.collection("clients").doc("client-1").set({
        active: true,
        name: "Cliente"
      }),
      adminModule.adminDb.collection("checkins").doc(checkInId).set({
        id: checkInId,
        status: "CHAMADO",
        plate: "ABC-1D23",
        version: 10,
        updatedAtIso: "2026-07-27T08:00:00.000Z"
      })
    ]);

    const first = {
      pump: "BOMBA_1",
      shiftDate: "2026-07-27",
      shiftType: "MANHA",
      startTime: "06:00",
      endTime: "06:10",
      category: "PRODUTIVO",
      clientId: "client-1",
      plate: "ZZZ9999",
      container: "ABCU1234560",
      containerStatus: "FULL",
      containerReason: null,
      startsNewContainerCycle: false,
      blendConfirmed: false,
      expectedContainerStateVersion: 0,
      notes: null,
      checkInId
    } as const;
    const second = {
      ...first,
      pump: "BOMBA_2" as const,
      container: "ABCU7654323"
    };
    const [firstPreview, secondPreview] = await Promise.all([
      gapService.previewEventGap(first),
      gapService.previewEventGap(second)
    ]);

    const results = await Promise.allSettled([
      eventsService.createEvent(
        { ...first, gapVersion: firstPreview.gapVersion },
        { uid: "operator-1", email: "one@example.com", role: "OPERATOR" }
      ),
      eventsService.createEvent(
        { ...second, gapVersion: secondPreview.gapVersion },
        { uid: "operator-2", email: "two@example.com", role: "OPERATOR" }
      )
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { status: 409, code: "CHECKIN_NOT_CALLED" }
    });

    const [events, checkin, revisions] = await Promise.all([
      adminModule.adminDb.collection("events").get(),
      adminModule.adminDb.collection("checkins").doc(checkInId).get(),
      adminModule.adminDb
        .collection("checkins")
        .doc(checkInId)
        .collection("revisions")
        .get()
    ]);
    expect(events.docs).toHaveLength(1);
    expect(checkin.data()).toMatchObject({
      status: "EM_DESCARGA",
      activeProductiveEventId: events.docs[0].id,
      version: 11
    });
    expect(revisions.docs).toHaveLength(1);
    expect(revisions.docs[0].data()).toMatchObject({
      action: "PRODUCTIVE_EVENT_LINKED",
      previousVersion: 10,
      newVersion: 11
    });
  });

  it("allows only one concurrent transfer to consume the same source version", async () => {
    const sourceContainer = "MSCU 663987-0";
    const sourceEvent = event({
      container: sourceContainer,
      containerStatus: "BUFFER",
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
      adminModule.adminDb.collection("events").doc("source-buffer").set(sourceEvent),
      adminModule.adminDb.collection("containerStates").doc("MSCU6639870").set({
        container: sourceContainer,
        status: "BUFFER",
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
      expectedContainerStateVersion: null,
      loadSourceType: "BUFFER_CONTAINER" as const,
      sourceContainer,
      sourceContainerEmptied: false,
      expectedSourceContainerStateVersion: 4,
      notes: null
    };
    const first = { ...baseInput, pump: "BOMBA_1" as const, container: "ABCU 123456-0" };
    const second = { ...baseInput, pump: "BOMBA_2" as const, container: "MATU 765432-1" };
    const [firstGap, secondGap] = await Promise.all([
      gapService.previewEventGap(first),
      gapService.previewEventGap(second)
    ]);

    const results = await Promise.allSettled([
      eventsService.createEvent({ ...first, gapVersion: firstGap.gapVersion }, {
        uid: "operator-1",
        email: "one@example.com",
        role: "OPERATOR"
      }),
      eventsService.createEvent({ ...second, gapVersion: secondGap.gapVersion }, {
        uid: "operator-2",
        email: "two@example.com",
        role: "OPERATOR"
      })
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const productive = await adminModule.adminDb
      .collection("events")
      .where("loadSourceType", "==", "BUFFER_CONTAINER")
      .get();
    expect(productive.docs).toHaveLength(1);
    const sourceState = await adminModule.adminDb
      .collection("containerStates")
      .doc("MSCU6639870")
      .get();
    expect(sourceState.data()).toMatchObject({ status: "BUFFER", version: 5 });
  });
});
