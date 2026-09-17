import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.FIREBASE_PROJECT_ID = "demo-transbordo";

type ClientsService = typeof import("@/lib/server/clients");
type AdminModule = typeof import("@/lib/firebase/admin");

let clientsService: ClientsService;
let adminModule: AdminModule;

async function clearCollection(name: string): Promise<void> {
  const snapshot = await adminModule.adminDb.collection(name).get();
  const batch = adminModule.adminDb.batch();

  snapshot.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
}

describe("client name uniqueness", () => {
  beforeAll(async () => {
    clientsService = await import("@/lib/server/clients");
    adminModule = await import("@/lib/firebase/admin");
  });

  beforeEach(async () => {
    await Promise.all([
      clearCollection("clients"),
      clearCollection("clientNameClaims"),
      clearCollection("_queueAccessAudit")
    ]);
    for (const uid of ["admin", "admin-1", "admin-2"]) await adminModule.adminDb.collection("users").doc(uid).set({role:"ADMIN", active:true, approved:true, email:"admin@example.test"});
  });

  it("allows only one concurrent create for the same normalized name", async () => {
    const results = await Promise.allSettled([
      clientsService.createClient("Acme", "admin-1"),
      clientsService.createClient("  acme  ", "admin-2")
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection).toMatchObject({
      reason: expect.objectContaining({ status: 409 })
    });

    const clients = await clientsService.listClients(true);
    expect(clients).toHaveLength(1);
    expect(clients[0]).toMatchObject({ nameUpper: "ACME" });
  });

  it("rejects a create that conflicts with a client predating name claims", async () => {
    await adminModule.adminDb.collection("clients").doc("legacy").set({
      name: "Acme",
      nameUpper: "ACME",
      active: true
    });

    await expect(
      clientsService.createClient("acme", "admin")
    ).rejects.toMatchObject({ status: 409 });
  });

  it("allows only one concurrent rename to the same normalized name", async () => {
    const alpha = await clientsService.createClient("Alpha", "admin");
    const beta = await clientsService.createClient("Beta", "admin");

    const results = await Promise.allSettled([
      clientsService.updateClient(alpha.id, { name: "Shared" }, "admin-1"),
      clientsService.updateClient(beta.id, { name: " shared " }, "admin-2")
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

    const clients = await clientsService.listClients(true);
    expect(
      clients.filter((client) => Reflect.get(client, "nameUpper") === "SHARED")
    ).toHaveLength(1);
  });

  it("releases the old name claim after a rename", async () => {
    const original = await clientsService.createClient("Original", "admin");

    await clientsService.updateClient(
      original.id,
      { name: "Renamed" },
      "admin"
    );
    const replacement = await clientsService.createClient("Original", "admin");

    expect(replacement).toMatchObject({
      name: "Original",
      nameUpper: "ORIGINAL"
    });
  });
  it("allows only one administrator to change the same client configuration version", async () => {
    const created = await clientsService.createClient("Versioned client", "admin");
    const results = await Promise.allSettled([
      clientsService.updateClient(created.id, {portalEnabled: true, expectedVersion: 0}, "admin-1"),
      clientsService.updateClient(created.id, {usesSample: false, expectedVersion: 0}, "admin-2")
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({reason: expect.objectContaining({status: 409})});
    expect((await adminModule.adminDb.collection("clients").doc(created.id).get()).data()?.accessVersion).toBe(1);
    const audit = await adminModule.adminDb.collection("_queueAccessAudit").where("action", "==", "CLIENT_UPDATED").get();
    expect(audit.size).toBe(1);
  });
  it("does not let concurrent role and approval changes bypass the user's access version", async () => {
    const users = await import("@/lib/server/users");
    await adminModule.adminDb.collection("users").doc("ux04-pending").set({role: "OPERATOR", approved: false, active: true});
    const results = await Promise.allSettled([
      users.setRole({targetUid: "ux04-pending", role: "ANALYST", actorUid: "admin-1", expectedVersion: 0}),
      users.setApproval({targetUid: "ux04-pending", approved: true, actorUid: "admin-2", actorEmail: "admin@example.test", expectedVersion: 0})
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({reason: expect.objectContaining({status: 409})});
    const stored = (await adminModule.adminDb.collection("users").doc("ux04-pending").get()).data()!;
    expect(stored.accessVersion).toBe(1);
    if (stored.role === "ANALYST") expect(stored.approved).toBe(false);
    expect((await adminModule.adminDb.collection("_queueAccessAudit").get()).size).toBe(1);
  });
});
