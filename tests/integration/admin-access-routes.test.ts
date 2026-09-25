import {beforeEach, describe, expect, it, vi} from "vitest";
import {NextRequest} from "next/server";
import {inMemoryAdminDb as db} from "../coverage/in-memory-firestore";
vi.mock("@/lib/firebase/admin", () => ({adminDb: db}));
vi.mock("@/lib/server/request-protection", () => ({protectApiRequest: vi.fn(async (request: Request) => ({uid: request.headers.get("x-test-uid"), email_verified: true}))}));
import {POST as changeRole} from "@/app/api/users/[uid]/role/route";
import {POST as changeApproval} from "@/app/api/users/[uid]/approve/route";
import {PATCH as changeClient} from "@/app/api/clients/[id]/route";
import {POST as legacyAccess} from "@/app/api/queue-access/route";
import {GET as getUsers} from "@/app/api/users/route";
import {setRole} from "@/lib/server/users";
import {createClient, updateClient} from "@/lib/server/clients";
const request = (path: string, body: object, uid="admin") => new NextRequest(`http://localhost${path}`, {method: path.startsWith("/api/clients/") ? "PATCH" : "POST", headers: {"x-test-uid": uid,"content-type":"application/json"}, body: JSON.stringify(body)});
const role = (body: object, actor="admin", target="pending") => changeRole(request(`/api/users/${target}/role`, body, actor), {params: Promise.resolve({uid: target})});
const approve = (body: object, actor="admin", target="pending") => changeApproval(request(`/api/users/${target}/approve`, body, actor), {params: Promise.resolve({uid: target})});
const client = (body: object, actor="admin") => changeClient(request("/api/clients/allog",body,actor), {params: Promise.resolve({id:"allog"})});

beforeEach(() => {
  db.reset();
  for (const [uid, role] of [["admin","ADMIN"],["supervisor","SUPERVISOR"],["analyst","ANALYST"],["customer","CUSTOMER"],["operator","OPERATOR"],["display","DISPLAY"]])
    db.seed("users",uid,{role,active:true,approved:true,email:`${uid}@example.test`,name:uid});
  db.seed("users","pending",{role:"OPERATOR",active:true,approved:false,email:"pending@example.test",name:"Conta de teste"});
  db.seed("clients","allog",{name:"ALLOG",nameUpper:"ALLOG",active:true,portalEnabled:true,usesSample:true});
  db.seed("clients","disabled",{name:"Outra",nameUpper:"OUTRA",active:true,portalEnabled:false,usesSample:true});
  db.seed("checkins","untouched",{status:"AGUARDANDO_LIBERACAO",sample:"OK",booking:"BK-DEMO",observation:"Valor preservado",clientId:"allog",version:4});
});

describe("integrated access administration", () => {
  it("saves a customer binding without approval, then approves in a separate versioned action", async () => {
    expect((await role({role:"CUSTOMER",clientId:"allog",expectedVersion:0})).status).toBe(200);
    expect(db.read("users","pending")).toMatchObject({role:"CUSTOMER",clientId:"allog",approved:false,accessVersion:1});
    expect(db.entries("_queueAccessAudit")).toHaveLength(1);
    expect((await approve({approved:true,expectedVersion:1})).status).toBe(200);
    expect(db.read("users","pending")).toMatchObject({approved:true,approvedByUid:"admin",accessVersion:2});
    const audits=db.entries("_queueAccessAudit").map(([,entry])=>entry);
    expect(audits).toEqual(expect.arrayContaining([expect.objectContaining({action:"USER_ROLE_CHANGED",after:{role:"CUSTOMER",clientId:"allog",approved:false}}),expect.objectContaining({action:"USER_APPROVED",previousVersion:1,newVersion:2})]));
  });
  it("preserves approval for existing approved users when saving analyst and removes their customer binding explicitly", async () => {
    db.seed("users","pending",{...db.read("users","pending"),approved:true,role:"CUSTOMER",clientId:"allog"});
    expect((await role({role:"ANALYST",clientId:null})).status).toBe(200);
    expect(db.read("users","pending")).toMatchObject({role:"ANALYST",clientId:null,approved:true,accessVersion:1});
  });
  it.each([null,"missing","disabled"])("rejects customer grant for unavailable company %s without changing account", async (clientId) => {
    expect((await role({role:"CUSTOMER",clientId})).status).toBe(400);
    expect(db.read("users","pending")).toMatchObject({role:"OPERATOR",approved:false});
    expect(db.entries("_queueAccessAudit")).toHaveLength(0);
  });
  it("rechecks company eligibility at approval, allowing explicit revocation even while the portal is off", async () => {
    await role({role:"CUSTOMER",clientId:"allog"});
    await client({portalEnabled:false});
    expect((await approve({approved:true,expectedVersion:1})).status).toBe(400);
    expect((await approve({approved:false,expectedVersion:1})).status).toBe(200);
    expect(db.read("users","pending")?.approved).toBe(false);
  });
  it("rejects inactive clients even with portal enabled", async () => {
    await client({active:false});
    expect((await role({role:"CUSTOMER",clientId:"allog"})).status).toBe(400);
  });
  it.each(["supervisor","analyst","customer","operator","display"])("denies %s administration across current and legacy routes", async actor => {
    expect((await role({role:"ADMIN"},actor)).status).toBe(403);
    expect((await approve({approved:true},actor)).status).toBe(403);
    expect((await client({portalEnabled:false},actor)).status).toBe(403);
    expect((await legacyAccess(request("/api/queue-access",{kind:"USER",uid:"pending",role:"ANALYST",clientId:null},actor))).status).toBe(403);
  });
  it("rechecks the administrator at the service transaction boundary", async () => {
    for (const patch of [{approved:false},{active:false},{role:"SUPERVISOR"}]) {
      db.seed("users","admin",{email:"admin@example.test",role:"ADMIN",approved:true,active:true,...patch});
      await expect(setRole({targetUid:"pending",role:"ANALYST",actorUid:"admin"})).rejects.toMatchObject({status:403});
      await expect(updateClient("allog",{usesSample:false},"admin")).rejects.toMatchObject({status:403});
      await expect(createClient("Fictício","admin")).rejects.toMatchObject({status:403});
    }
    expect(db.entries("_queueAccessAudit")).toHaveLength(0);
  });
  it("protects the current administrator from self-demotion and approval revocation", async () => {
    expect((await role({role:"ANALYST"},"admin","admin")).status).toBe(409);
    expect((await approve({approved:false},"admin","admin")).status).toBe(409);
    expect(db.read("users","admin")).toMatchObject({role:"ADMIN",approved:true});
  });
  it("uses one version for role and approval so stale requests do not overwrite", async () => {
    await role({role:"ANALYST"});
    expect((await approve({approved:true})).status).toBe(409);
    expect((await role({role:"ADMIN",expectedVersion:0})).status).toBe(409);
    expect(db.read("users","pending")).toMatchObject({role:"ANALYST",approved:false,accessVersion:1});
    expect(db.entries("_queueAccessAudit")).toHaveLength(1);
  });
  it("version-controls client options and preserves every visit field", async () => {
    const before=db.read("checkins","untouched");
    expect((await client({portalEnabled:false,usesSample:false,expectedVersion:0})).status).toBe(200);
    expect((await client({active:false,expectedVersion:0})).status).toBe(409);
    expect(db.read("clients","allog")).toMatchObject({active:true,portalEnabled:false,usesSample:false,accessVersion:1});
    expect(db.read("checkins","untouched")).toEqual(before);
    expect(db.entries("_queueAccessAudit")[0][1]).toMatchObject({action:"CLIENT_UPDATED",before:{portalEnabled:true,usesSample:true},after:{portalEnabled:false,usesSample:false}});
  });
  it("keeps the legacy route compatible without implicit approval or a version bypass", async () => {
    const command={kind:"USER",uid:"pending",role:"CUSTOMER",clientId:"allog"};
    expect((await legacyAccess(request("/api/queue-access",command))).status).toBe(200);
    expect(db.read("users","pending")).toMatchObject({approved:false,role:"CUSTOMER",clientId:"allog",accessVersion:1});
    expect((await legacyAccess(request("/api/queue-access",{...command,role:"ANALYST",clientId:null}))).status).toBe(409);
    expect((await legacyAccess(request("/api/queue-access",{kind:"CLIENT",clientId:"allog",portalEnabled:false,usesSample:false}))).status).toBe(200);
    expect((await client({portalEnabled:true})).status).toBe(409);
  });
  it("rejects unknown access fields and malformed versions", async () => {
    expect((await role({role:"ANALYST",approved:true})).status).toBe(400);
    expect((await approve({approved:true,role:"ADMIN"})).status).toBe(400);
    for (const expectedVersion of [-1,0.5,"0"]) expect((await client({usesSample:false,expectedVersion})).status).toBe(400);
  });
  it("returns legacy accounts with default version zero for the Users screen", async () => {
    const response=await getUsers(new NextRequest("http://localhost/api/users",{headers:{"x-test-uid":"admin"}}));
    expect(response.status).toBe(200);
    expect((await response.json()).data.items).toEqual(expect.arrayContaining([expect.objectContaining({id:"pending",accessVersion:0})]));
  });
});
