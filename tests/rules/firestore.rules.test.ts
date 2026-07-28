import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  RulesTestEnvironment
} from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc } from "firebase/firestore";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";

const projectId = "demo-transbordo";

let testEnv: RulesTestEnvironment;

async function seedProfiles() {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();

    await setDoc(doc(db, "users", "operator-1"), {
      email: "operator@example.com",
      role: "OPERATOR",
      approved: true,
      active: true
    });
    await setDoc(doc(db, "users", "admin-1"), {
      email: "admin@example.com",
      role: "ADMIN",
      approved: true,
      active: true
    });
    await setDoc(doc(db, "users", "display-1"), {
      email: "display@example.com",
      role: "DISPLAY",
      approved: true,
      active: true
    });
    await setDoc(doc(db, "users", "pending-admin"), {
      email: "pending@example.com",
      role: "ADMIN",
      approved: false,
      active: true
    });
    await setDoc(doc(db, "users", "inactive-admin"), {
      email: "inactive@example.com",
      role: "ADMIN",
      approved: true,
      active: false
    });
    await setDoc(doc(db, "clients", "client-1"), {
      name: "Cliente",
      active: true
    });
    await setDoc(doc(db, "events", "event-1"), {
      createdByUid: "operator-1",
      deleted: false
    });
    await setDoc(doc(db, "events", "event-1", "revisions", "revision-1"), {
      editedByUid: "admin-1"
    });
    await setDoc(doc(db, "containerStates", "ABCU1234560"), {
      status: "PARTIAL"
    });
  });
}

beforeAll(async () => {
  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
  const [host, portText] = emulatorHost.split(":");

  testEnv = await initializeTestEnvironment({
    projectId,
    firestore: {
      host,
      port: Number(portText)
    }
  });
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await seedProfiles();
});

afterAll(async () => {
  await testEnv.cleanup();
});

describe("Firestore user profile rules", () => {
  it("allows a signed-in user to read only their own profile", async () => {
    const db = testEnv.authenticatedContext("operator-1").firestore();

    await assertSucceeds(getDoc(doc(db, "users", "operator-1")));
    await assertFails(getDoc(doc(db, "users", "admin-1")));
  });

  it("blocks a new user from creating an approved admin profile", async () => {
    const db = testEnv.authenticatedContext("attacker-1").firestore();

    await assertFails(
      setDoc(doc(db, "users", "attacker-1"), {
        email: "attacker@example.com",
        role: "ADMIN",
        approved: true,
        active: true
      })
    );
  });

  it("blocks a user from changing their own authorization fields", async () => {
    const db = testEnv.authenticatedContext("operator-1").firestore();

    await assertFails(
      updateDoc(doc(db, "users", "operator-1"), {
        role: "ADMIN",
        approved: true,
        active: true
      })
    );
  });

  it("allows only an approved and active admin to read another profile", async () => {
    const approvedAdminDb = testEnv.authenticatedContext("admin-1").firestore();
    const pendingAdminDb = testEnv.authenticatedContext("pending-admin").firestore();
    const inactiveAdminDb = testEnv.authenticatedContext("inactive-admin").firestore();

    await assertSucceeds(getDoc(doc(approvedAdminDb, "users", "operator-1")));
    await assertFails(getDoc(doc(pendingAdminDb, "users", "operator-1")));
    await assertFails(getDoc(doc(inactiveAdminDb, "users", "operator-1")));
  });
});

describe("Firestore domain collection rules", () => {
  it("keeps domain data behind the authenticated API", async () => {
    const db = testEnv.authenticatedContext("operator-1").firestore();

    await assertFails(getDoc(doc(db, "clients", "client-1")));
    await assertFails(getDoc(doc(db, "events", "event-1")));
    await assertFails(
      getDoc(doc(db, "events", "event-1", "revisions", "revision-1"))
    );
  });

  it("blocks DISPLAY from reading operational collections directly", async () => {
    const db = testEnv.authenticatedContext("display-1").firestore();

    await assertSucceeds(getDoc(doc(db, "users", "display-1")));
    await assertFails(getDoc(doc(db, "clients", "client-1")));
    await assertFails(getDoc(doc(db, "events", "event-1")));
    await assertFails(
      getDoc(doc(db, "events", "event-1", "revisions", "revision-1"))
    );
  });

  it("blocks direct domain writes even for an approved admin", async () => {
    const db = testEnv.authenticatedContext("admin-1").firestore();

    await assertFails(setDoc(doc(db, "clients", "client-2"), { name: "Novo" }));
    await assertFails(setDoc(doc(db, "events", "event-2"), { deleted: false }));
    await assertFails(
      setDoc(doc(db, "events", "event-1", "revisions", "revision-2"), {
        editedByUid: "admin-1"
      })
    );
    await assertFails(
      setDoc(doc(db, "containerStates", "ABCU1234560"), {
        status: "FULL"
      })
    );
  });

  it("keeps materialized container state behind the authenticated API", async () => {
    const db = testEnv.authenticatedContext("operator-1").firestore();
    await assertFails(getDoc(doc(db, "containerStates", "ABCU1234560")));
  });
});
