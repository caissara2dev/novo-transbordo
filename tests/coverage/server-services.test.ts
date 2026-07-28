import { Timestamp } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { inMemoryAdminDb } from "./in-memory-firestore";

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: inMemoryAdminDb
}));

import {
  createClient,
  listClients,
  updateClient
} from "@/lib/server/clients";
import {
  getOperationalSettings,
  updateOperationalSettings
} from "@/lib/server/operational-settings";
import {
  ensureUserProfile,
  listUsers,
  setApproval,
  setRole
} from "@/lib/server/users";

describe("public Firestore-backed administration services", () => {
  beforeEach(() => {
    inMemoryAdminDb.reset();
  });

  it("creates, lists, renames and deactivates clients with normalized uniqueness", async () => {
    const acme = await createClient("  Acme  ", "admin-1");
    const beta = await createClient("Beta", "admin-1");

    expect(acme).toMatchObject({
      name: "Acme",
      nameUpper: "ACME",
      active: true
    });
    expect(
      (await listClients(false)).map((client) => Reflect.get(client, "name"))
    ).toEqual(["Acme", "Beta"]);

    const renamed = await updateClient(
      beta.id,
      { name: "Gamma", active: false },
      "admin-2"
    );
    expect(renamed).toMatchObject({
      name: "Gamma",
      nameUpper: "GAMMA",
      active: false,
      updatedByUid: "admin-2"
    });
    expect(await listClients(false)).toHaveLength(1);

    await expect(createClient("acme", "admin-3")).rejects.toMatchObject({
      status: 409
    });
    await expect(
      updateClient(acme.id, { name: "Gamma" }, "admin-3")
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rejects invalid or missing clients without leaving a name claim behind", async () => {
    await expect(createClient("   ", "admin")).rejects.toMatchObject({
      status: 400
    });
    await expect(
      updateClient("missing", { name: "Available" }, "admin")
    ).rejects.toMatchObject({ status: 404 });
    expect(inMemoryAdminDb.entries("clientNameClaims")).toHaveLength(0);
  });

  it("creates and refreshes user profiles and applies approval and role changes", async () => {
    await ensureUserProfile({
      uid: "operator-1",
      email: "operator@example.com",
      name: "Operador"
    });
    await ensureUserProfile({
      uid: "operator-1",
      email: "renamed@example.com",
      name: "Operador Atualizado"
    });
    await ensureUserProfile({
      uid: "operator-2",
      email: "second@example.com",
      name: null
    });

    const approved = await setApproval({
      targetUid: "operator-1",
      approved: true,
      actorUid: "admin-1",
      actorEmail: "admin@example.com"
    });
    expect(approved).toMatchObject({
      email: "renamed@example.com",
      approved: true,
      approvedByUid: "admin-1"
    });

    const denied = await setApproval({
      targetUid: "operator-1",
      approved: false,
      actorUid: "admin-2",
      actorEmail: "other-admin@example.com"
    });
    expect(denied).toMatchObject({
      approved: false,
      approvedAt: null,
      approvedByUid: null,
      approvedByEmail: null
    });

    const supervisor = await setRole({
      targetUid: "operator-1",
      role: "SUPERVISOR",
      actorUid: "admin-1"
    });
    expect(supervisor).toMatchObject({
      role: "SUPERVISOR",
      updatedByUid: "admin-1"
    });
    expect(await listUsers()).toHaveLength(2);
  });

  it("reports missing targets for approval and role changes", async () => {
    await expect(
      setApproval({
        targetUid: "missing",
        approved: true,
        actorUid: "admin",
        actorEmail: "admin@example.com"
      })
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      setRole({
        targetUid: "missing",
        role: "ADMIN",
        actorUid: "admin"
      })
    ).rejects.toMatchObject({ status: 404 });
  });

  it("uses a safe tolerance default and persists a validated override", async () => {
    expect(await getOperationalSettings()).toEqual({
      idleToleranceMinutes: 10
    });

    inMemoryAdminDb.seed("settings", "operations", {
      idleToleranceMinutes: 90
    });
    expect(await getOperationalSettings()).toEqual({
      idleToleranceMinutes: 10
    });

    await expect(
      updateOperationalSettings(
        { idleToleranceMinutes: 61 },
        { uid: "admin", email: "admin@example.com" }
      )
    ).rejects.toBeDefined();

    expect(
      await updateOperationalSettings(
        { idleToleranceMinutes: 0 },
        { uid: "admin", email: "admin@example.com" }
      )
    ).toEqual({ idleToleranceMinutes: 0 });
    expect(await getOperationalSettings()).toEqual({
      idleToleranceMinutes: 0
    });
  });

  it("orders users using Firestore timestamp values", async () => {
    inMemoryAdminDb.seed("users", "older", {
      email: "older@example.com",
      createdAt: Timestamp.fromMillis(1)
    });
    inMemoryAdminDb.seed("users", "newer", {
      email: "newer@example.com",
      createdAt: Timestamp.fromMillis(2)
    });

    expect((await listUsers()).map((user) => user.id)).toEqual([
      "newer",
      "older"
    ]);
  });
});
