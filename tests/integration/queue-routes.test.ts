import { beforeEach, describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { inMemoryAdminDb as db } from "../coverage/in-memory-firestore";
vi.mock("@/lib/firebase/admin", () => ({ adminDb: db }));
vi.mock("@/lib/server/request-protection", () => ({
  protectApiRequest: vi.fn(async (req: Request) => ({
    uid: req.headers.get("x-test-uid"),
    email_verified: req.headers.get("x-test-unverified") !== "true",
  })),
}));
import { GET as listCustomer } from "@/app/api/customer/checkins/route";
import { PATCH as patchCustomer } from "@/app/api/customer/checkins/[id]/route";
import { GET as listInternal } from "@/app/api/checkins/route";
import {
  GET as listAccess,
  POST as grantAccess,
} from "@/app/api/queue-access/route";
import { GET as listCalled } from "@/app/api/checkins/called/route";
import { POST as attachDocument, GET as readDocument } from "@/app/api/checkins/[id]/document/route";
const req = (path: string, uid: string, body?: unknown) =>
  new NextRequest(`http://localhost${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-test-uid": uid, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const visit = {
  id: "visit",
  status: "AGUARDANDO_LIBERACAO",
  version: 2,
  clientId: "allog",
  clientNameSnapshot: "ALLOG",
  driverName: "Motorista Demo",
  plate: "ABC-1D23",
  driverLicense: "PRIVATE_CNH",
  driverPhone: "PRIVATE_PHONE",
  location: { latitude: 1, longitude: 2 },
  issues: [{ id: "p", description: "PRIVATE_ISSUE", resolved: false }],
  booking: "DEMO",
  sample: "",
  observation: "",
  createdAtIso: "2026-09-10T12:00:00.000Z",
  confirmedAtIso: "2026-09-10T12:01:00.000Z",
};
beforeEach(() => {
  db.reset();
  vi.unstubAllEnvs();
  vi.stubEnv("CHECKIN_SYSTEM_RECORD_ENABLED", "true");
  vi.stubEnv("CHECKIN_INTEGRATION_MODE", "observe");
  for (const [uid, role] of [
    ["admin", "ADMIN"],
    ["analyst", "ANALYST"],
    ["customer", "CUSTOMER"],
    ["operator", "OPERATOR"],
    ["display", "DISPLAY"],
  ])
    db.seed("users", uid, {
      role,
      active: true,
      approved: true,
      clientId: role === "CUSTOMER" ? "allog" : null,
      name: uid,
      email: `${uid}@example.test`,
    });
  db.seed("users", "pending", {
    role: "OPERATOR",
    active: true,
    approved: false,
  });
  db.seed("clients", "allog", {
    name: "ALLOG",
    active: true,
    portalEnabled: true,
    usesSample: true,
  });
  db.seed("clients", "disabled", {
    name: "Disabled",
    active: true,
    portalEnabled: false,
    usesSample: false,
  });
  db.seed("checkins", "visit", visit);
  db.seed("checkins", "foreign", {
    ...visit,
    id: "foreign",
    clientId: "disabled",
    driverName: "PRIVATE_FOREIGN",
  });
});
describe("authenticated queue API", () => {
  it.each(["customer", "operator", "display", "pending"])("denies %s internal invoice upload with a private error response", async(uid) => {
    const id="66a2f3e0-22fb-4be5-9b87-5f927fbd8d63";
    const response=await attachDocument(req(`/api/checkins/${id}/document`,uid,{action:"begin",operationId:"50d639aa-b2ba-4384-8846-c21585a504a7",expectedVersion:2,name:"demo.pdf",size:100}),{params:Promise.resolve({id})});
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(JSON.stringify(await response.json())).not.toContain("uploadUrl");
  });
  it.each(["customer", "operator", "display", "pending"])("denies %s private document history and version download", async(uid) => {
    const id="66a2f3e0-22fb-4be5-9b87-5f927fbd8d63";
    for (const query of ["history=true", "version=50d639aa-b2ba-4384-8846-c21585a504a7"]) {
      const response=await readDocument(req(`/api/checkins/${id}/document?${query}`,uid),{params:Promise.resolve({id})});
      expect(response.status).toBe(403);
      expect(response.headers.get("Cache-Control")).toContain("no-store");
      expect(JSON.stringify(await response.json())).not.toMatch(/uploadUrl|sha256|storage.googleapis/);
    }
  });
  it("serves private version history through the authenticated route", async()=>{
    const id="66a2f3e0-22fb-4be5-9b87-5f927fbd8d63";
    db.seed("checkins",id,{...visit,id});
    const response=await readDocument(req(`/api/checkins/${id}/document?history=true`,"analyst"),{params:Promise.resolve({id})});
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect((await response.json()).data).toEqual({items:[],nextCursor:null});
  });
  it("requires valid upload input and enabled queue before starting storage work", async()=>{
    const id="66a2f3e0-22fb-4be5-9b87-5f927fbd8d63";
    const context={params:Promise.resolve({id})};
    expect((await attachDocument(req(`/api/checkins/${id}/document`,"analyst",{action:"delete"}),context)).status).toBe(400);
    vi.stubEnv("CHECKIN_SYSTEM_RECORD_ENABLED","false");
    const response=await attachDocument(req(`/api/checkins/${id}/document`,"analyst",{}),context);
    expect(response.status).toBe(503);expect(response.headers.get("Cache-Control")).toContain("no-store");
  });
  it("scopes a customer response and prevents private fields reaching the browser", async () => {
    const response = await listCustomer(
      req("/api/customer/checkins", "customer"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    const body = await response.json();
    expect(body.data.items).toHaveLength(1);
    expect(JSON.stringify(body)).not.toMatch(
      /PRIVATE_|location|issues|driverLicense|driverPhone/,
    );
  });
  it.each(["customer", "operator", "display"])(
    "denies %s the analyst queue",
    async (uid) => {
      expect((await listInternal(req("/api/checkins", uid))).status).toBe(403);
    },
  );
  it("allows an approved analyst while a missing or unverified user is denied", async () => {
    expect((await listInternal(req("/api/checkins", "analyst"))).status).toBe(
      200,
    );
    expect((await listInternal(req("/api/checkins", "unknown"))).status).toBe(
      404,
    );
    const unverified = req("/api/checkins", "analyst");
    unverified.headers.set("x-test-unverified", "true");
    expect((await listInternal(unverified)).status).toBe(403);
  });
  it("rejects a forged client PATCH and preserves the original row", async () => {
    const request = new NextRequest(
      "http://localhost/api/customer/checkins/foreign",
      {
        method: "PATCH",
        headers: { "x-test-uid": "customer" },
        body: JSON.stringify({
          expectedVersion: 2,
          command: {
            kind: "SHARED",
            shared: { booking: "FORGED", sample: "", observation: "" },
          },
        }),
      },
    );
    expect(
      (
        await patchCustomer(request, {
          params: Promise.resolve({ id: "foreign" }),
        })
      ).status,
    ).toBe(404);
    expect(db.read("checkins", "foreign")?.booking).toBe("DEMO");
  });
  it("does not offer visits with unresolved issues to operators", async () => {
    db.seed("checkins", "visit", { ...visit, status: "CHAMADO" });
    let result = await listCalled(req("/api/checkins/called", "operator"));
    expect((await result.json()).data.items).toEqual([]);
    db.seed("checkins", "visit", { ...visit, status: "CHAMADO", issues: [] });
    result = await listCalled(req("/api/checkins/called", "operator"));
    const body = await result.json();
    expect(body.data.items).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain("PRIVATE_");
  });
});
describe("administrator grants explicit participation", () => {
  it.each(["analyst", "customer", "operator", "display"])(
    "denies %s access administration",
    async (uid) => {
      expect((await listAccess(req("/api/queue-access", uid))).status).toBe(
        403,
      );
      expect(
        (
          await grantAccess(
            req("/api/queue-access", uid, {
              kind: "CLIENT",
              clientId: "disabled",
              portalEnabled: true,
              usesSample: false,
            }),
          )
        ).status,
      ).toBe(403);
      expect(db.read("clients", "disabled")?.portalEnabled).toBe(false);
    },
  );
  it("requires client enablement before binding an account and records audit", async () => {
    const command = {
      kind: "USER",
      uid: "pending",
      role: "CUSTOMER",
      clientId: "disabled",
    };
    expect(
      (await grantAccess(req("/api/queue-access", "admin", command))).status,
    ).toBe(400);
    expect(
      (
        await grantAccess(
          req("/api/queue-access", "admin", {
            kind: "CLIENT",
            clientId: "disabled",
            portalEnabled: true,
            usesSample: false,
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (await grantAccess(req("/api/queue-access", "admin", command))).status,
    ).toBe(200);
    expect(db.read("users", "pending")).toMatchObject({
      role: "CUSTOMER",
      clientId: "disabled",
      approved: true,
    });
    expect(db.entries("_queueAccessAudit")).toHaveLength(2);
    expect(
      (
        await grantAccess(
          req("/api/queue-access", "admin", {
            ...command,
            role: "ANALYST",
            clientId: null,
          }),
        )
      ).status,
    ).toBe(200);
    expect(db.read("users", "pending")?.clientId).toBeNull();
  });
  it("rejects unknown fields and protects the current admin's own role", async () => {
    expect(
      (
        await grantAccess(
          req("/api/queue-access", "admin", {
            kind: "CLIENT",
            clientId: "disabled",
            portalEnabled: true,
            usesSample: false,
            active: true,
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await grantAccess(
          req("/api/queue-access", "admin", {
            kind: "USER",
            uid: "admin",
            role: "ANALYST",
            clientId: null,
          }),
        )
      ).status,
    ).toBe(409);
  });
});
