import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const eventMocks = vi.hoisted(() => ({
  createEvent: vi.fn(),
  listEvents: vi.fn(),
  updateEvent: vi.fn(),
  softDeleteEvent: vi.fn(),
  previewEventRestore: vi.fn(),
  restoreEvent: vi.fn(),
  previewEventGap: vi.fn()
}));

const authCtx = {
  uid: "u1",
  email: "operator@x.com",
  profile: {
    role: "OPERATOR",
    approved: true,
    active: true,
    email: "operator@x.com",
    name: null,
    createdAt: null,
    updatedAt: null,
    approvedAt: null,
    approvedByUid: null,
    approvedByEmail: null
  }
};

vi.mock("@/lib/server/auth", () => ({
  requireAuth: vi.fn(async () => authCtx),
  ensureApproved: vi.fn(),
  ensureRole: vi.fn()
}));

vi.mock("@/lib/server/events", () => ({
  createEvent: eventMocks.createEvent,
  listEvents: eventMocks.listEvents,
  updateEvent: eventMocks.updateEvent,
  softDeleteEvent: eventMocks.softDeleteEvent,
  previewEventRestore: eventMocks.previewEventRestore,
  restoreEvent: eventMocks.restoreEvent
}));

vi.mock("@/lib/server/gaps", () => ({
  previewEventGap: eventMocks.previewEventGap
}));

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({
        get: vi.fn(async () => ({
          exists: true,
          data: () => ({
            createdAt: {
              _seconds: Math.floor(Date.now() / 1000),
              _nanoseconds: 0
            }
          })
        }))
      }))
    }))
  }
}));

function validEventPayload() {
  return {
    pump: "BOMBA_1",
    shiftDate: "2026-07-28",
    shiftType: "MANHA",
    startTime: "08:00",
    endTime: "08:30",
    category: "PRODUTIVO",
    clientId: "client-1",
    plate: "ABC1D23",
    container: "ABCU1234560",
    containerStatus: "FULL",
    containerReason: null,
    startsNewContainerCycle: false,
    blendConfirmed: false,
    expectedContainerStateVersion: null,
    notes: null,
    revisionReason: null,
    gapVersion: "gap-v1",
    gapJustifications: [],
    gapJustificationsByEvent: {}
  };
}

describe("events API routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authCtx.profile.role = "OPERATOR";
    eventMocks.createEvent.mockResolvedValue({
      id: "e1",
      warnings: [],
      pump: "BOMBA_1"
    });
    eventMocks.listEvents.mockResolvedValue({
      items: [{ id: "e1", pump: "BOMBA_1" }],
      nextCursor: "next-events",
      incomplete: false
    });
    eventMocks.updateEvent.mockResolvedValue({ id: "e1" });
    eventMocks.softDeleteEvent.mockResolvedValue({ ok: true });
    eventMocks.previewEventRestore.mockResolvedValue({
      gapVersion: "restore-v2",
      changedSinceDeletion: true,
      expectedContainerStateVersion: 4,
      reconciliations: []
    });
    eventMocks.restoreEvent.mockResolvedValue({ ok: true });
    eventMocks.previewEventGap.mockResolvedValue({
      gapVersion: "gap-v1",
      reconciliations: []
    });
  });

  it("GET /api/events returns list payload", async () => {
    const mod = await import("@/app/api/events/route");
    const req = new NextRequest("http://localhost/api/events?dateFrom=2026-02-06");

    const res = await mod.GET(req);
    const body = (await res.json()).data;

    expect(res.status).toBe(200);
    expect(body.items).toHaveLength(1);
    expect(body.nextCursor).toBe("next-events");
    expect(body.incomplete).toBe(false);
  });

  it("GET /api/events forwards validated pagination", async () => {
    const mod = await import("@/app/api/events/route");
    const server = await import("@/lib/server/events");
    const req = new NextRequest(
      "http://localhost/api/events?limit=75&cursor=opaque-events"
    );

    const res = await mod.GET(req);

    expect(res.status).toBe(200);
    expect(server.listEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "OPERATOR",
        uid: "u1",
        pagination: {
          limit: 75,
          cursor: "opaque-events"
        }
      })
    );
  });

  it("GET /api/events rejects an invalid page limit", async () => {
    const mod = await import("@/app/api/events/route");
    const server = await import("@/lib/server/events");
    const req = new NextRequest("http://localhost/api/events?limit=201");

    const res = await mod.GET(req);

    expect(res.status).toBe(400);
    expect(server.listEvents).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid pump", "pump=BOMBA_9"],
    ["impossible date", "dateFrom=2026-02-30"],
    ["reversed dates", "dateFrom=2026-07-28&dateTo=2026-07-27"],
    ["invalid boolean", "includeDeleted=1"],
    ["empty cursor", "cursor="],
    ["oversized client id", `clientId=${"x".repeat(129)}`]
  ])("GET /api/events rejects %s", async (_label, query) => {
    const mod = await import("@/app/api/events/route");
    const server = await import("@/lib/server/events");
    const req = new NextRequest(`http://localhost/api/events?${query}`);

    const res = await mod.GET(req);

    expect(res.status).toBe(400);
    expect(server.listEvents).not.toHaveBeenCalled();
  });

  it("POST /api/events returns created item", async () => {
    const mod = await import("@/app/api/events/route");
    const req = new NextRequest("http://localhost/api/events", {
      method: "POST",
      body: JSON.stringify(validEventPayload()),
      headers: {
        "content-type": "application/json"
      }
    });

    const res = await mod.POST(req);
    const body = (await res.json()).data;

    expect(res.status).toBe(201);
    expect(body.item.id).toBe("e1");
  });

  it.each([
    ["malformed JSON", "{"],
    ["unknown field", JSON.stringify({ ...validEventPayload(), admin: true })],
    ["mistyped field", JSON.stringify({ ...validEventPayload(), blendConfirmed: "false" })]
  ])("POST /api/events rejects %s", async (_label, body) => {
    const mod = await import("@/app/api/events/route");
    const response = await mod.POST(
      new NextRequest("http://localhost/api/events", {
        method: "POST",
        body
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" }
    });
    expect(eventMocks.createEvent).not.toHaveBeenCalled();
  });

  it("PATCH and DELETE reject fields outside their strict mutation contracts", async () => {
    authCtx.profile.role = "SUPERVISOR";
    const mod = await import("@/app/api/events/[id]/route");
    const context = { params: Promise.resolve({ id: "e1" }) };
    const patchResponse = await mod.PATCH(
      new NextRequest("http://localhost/api/events/e1", {
        method: "PATCH",
        body: JSON.stringify({ ...validEventPayload(), admin: true })
      }),
      context
    );
    const deleteResponse = await mod.DELETE(
      new NextRequest("http://localhost/api/events/e1", {
        method: "DELETE",
        body: JSON.stringify({
          reason: "Correção",
          gapVersion: "gap-v1",
          gapJustifications: [],
          force: true
        })
      }),
      context
    );

    expect(patchResponse.status).toBe(400);
    expect(deleteResponse.status).toBe(400);
    expect(eventMocks.updateEvent).not.toHaveBeenCalled();
    expect(eventMocks.softDeleteEvent).not.toHaveBeenCalled();
  });

  it("gap preview rejects malformed, unknown and mistyped fields", async () => {
    const mod = await import("@/app/api/events/gap-preview/route");

    for (const body of [
      "{",
      JSON.stringify({
        pump: "BOMBA_1",
        shiftDate: "2026-07-28",
        shiftType: "MANHA",
        startTime: "08:00",
        admin: true
      }),
      JSON.stringify({
        pump: "BOMBA_1",
        shiftDate: "2026-07-28",
        shiftType: "MANHA",
        startTime: 800
      })
    ]) {
      const response = await mod.POST(
        new NextRequest("http://localhost/api/events/gap-preview", {
          method: "POST",
          body
        })
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        error: { code: "VALIDATION_ERROR" }
      });
    }

    expect(eventMocks.previewEventGap).not.toHaveBeenCalled();
  });

  it("GET /api/events/:id/restore returns the current reconciliation preview", async () => {
    const mod = await import("@/app/api/events/[id]/restore/route");
    const req = new NextRequest("http://localhost/api/events/e1/restore");

    const res = await mod.GET(req, {
      params: Promise.resolve({ id: "e1" })
    });
    const body = (await res.json()).data;

    expect(res.status).toBe(200);
    expect(body.gapVersion).toBe("restore-v2");
    expect(body.changedSinceDeletion).toBe(true);
    expect(body.expectedContainerStateVersion).toBe(4);
  });

  it("POST /api/events/:id/restore confirms the container version from preview", async () => {
    const mod = await import("@/app/api/events/[id]/restore/route");
    const server = await import("@/lib/server/events");
    const req = new NextRequest("http://localhost/api/events/e1/restore", {
      method: "POST",
      body: JSON.stringify({
        gapVersion: "restore-v2",
        expectedContainerStateVersion: 4
      })
    });

    const res = await mod.POST(req, {
      params: Promise.resolve({ id: "e1" })
    });

    expect(res.status).toBe(200);
    expect(server.restoreEvent).toHaveBeenCalledWith(
      "e1",
      { uid: "u1", email: "operator@x.com" },
      expect.objectContaining({ expectedContainerStateVersion: 4 })
    );
  });

  it("POST /api/events/:id/restore rejects a missing preview confirmation", async () => {
    const mod = await import("@/app/api/events/[id]/restore/route");
    const req = new NextRequest("http://localhost/api/events/e1/restore", {
      method: "POST"
    });

    const res = await mod.POST(req, {
      params: Promise.resolve({ id: "e1" })
    });

    expect(res.status).toBe(400);
  });

  it("POST /api/events/:id/restore rejects malformed and unsafe reconciliation payloads", async () => {
    const mod = await import("@/app/api/events/[id]/restore/route");

    for (const body of [
      "{",
      JSON.stringify({
        gapVersion: "restore-v2",
        expectedContainerStateVersion: 4,
        gapJustificationsByEvent: {},
        force: true
      }),
      JSON.stringify({
        gapVersion: "restore-v2",
        expectedContainerStateVersion: "4",
        gapJustificationsByEvent: {}
      })
    ]) {
      const response = await mod.POST(
        new NextRequest("http://localhost/api/events/e1/restore", {
          method: "POST",
          body
        }),
        { params: Promise.resolve({ id: "e1" }) }
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        error: { code: "VALIDATION_ERROR" }
      });
    }

    expect(eventMocks.restoreEvent).not.toHaveBeenCalled();
  });
});
