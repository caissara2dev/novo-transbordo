import { Timestamp } from "firebase-admin/firestore";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EventDoc } from "@/types/domain";

process.env.FIREBASE_PROJECT_ID = "demo-transbordo";

type AdminModule = typeof import("@/lib/firebase/admin");
type EventsService = typeof import("@/lib/server/events");
type ContainerService = typeof import("@/lib/server/container-states");
type GapService = typeof import("@/lib/server/gaps");

let adminModule: AdminModule;
let eventsService: EventsService;
let containerService: ContainerService;
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
    containerService = await import("@/lib/server/container-states");
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

  it("rolls back every timeline write when reconciliation aborts after planning", async () => {
    await adminModule.adminDb
      .collection("events")
      .doc("first")
      .set(
        event({
          endAt: Timestamp.fromMillis(1_000),
          createdAt: Timestamp.fromMillis(1_100)
        })
      );
    await adminModule.adminDb
      .collection("events")
      .doc("last")
      .set(
        event({
          endAt: Timestamp.fromMillis(3_000),
          createdAt: Timestamp.fromMillis(3_100),
          containerStatus: "FULL",
          containerReason: null,
          previousContainerEventId: "first"
        })
      );

    await expect(
      adminModule.adminDb.runTransaction(async (transaction) => {
        await containerService.reconcileContainerTimelineInTransaction({
          transaction,
          rawContainer: "ABCU 123456-0",
          override: {
            id: "retroactive",
            data: event({
              endAt: Timestamp.fromMillis(2_000),
              createdAt: Timestamp.fromMillis(2_100),
              containerCycleId: null
            })
          }
        });
        throw new Error("abort-after-plan");
      })
    ).rejects.toThrow("abort-after-plan");

    const state = await adminModule.adminDb
      .collection("containerStates")
      .doc("ABCU1234560")
      .get();
    const last = await adminModule.adminDb
      .collection("events")
      .doc("last")
      .get();
    expect(state.exists).toBe(false);
    expect(last.data()?.previousContainerEventId).toBe("first");
  });
});
