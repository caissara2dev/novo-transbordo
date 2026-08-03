import { expect, Page, test } from "@playwright/test";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const projectId = "demo-transbordo-e2e";
const email = "container-status.e2e@example.com";
const emulatorCredential = "local-emulator-only";
const adminApp = initializeApp({ projectId }, "container-status-e2e");
const emulatorAuth = getAuth(adminApp);

const profile = {
  uid: "",
  email,
  name: "Container Status E2E",
  role: "ADMIN",
  approved: true,
  active: true,
  createdAt: null,
  updatedAt: null,
  approvedAt: null,
  approvedByUid: null,
  approvedByEmail: null
};

function json(body: unknown) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body)
  };
}

async function mockSession(page: Page): Promise<void> {
  await page.route("**/api/auth/sync", (route) =>
    route.fulfill(json({ ok: true, data: { profile }, profile }))
  );
  await page.route("**/api/me", (route) =>
    route.fulfill(
      json({
        ok: true,
        data: { profile, approvalContactPhone: null },
        profile,
        approvalContactPhone: null
      })
    )
  );
}

async function login(page: Page): Promise<void> {
  await mockSession(page);
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Senha").fill(emulatorCredential);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

test.beforeAll(async () => {
  const existing = await emulatorAuth.getUserByEmail(email).catch(() => null);
  if (existing) {
    await emulatorAuth.deleteUser(existing.uid);
  }
  const created = await emulatorAuth.createUser({
    email,
    password: emulatorCredential,
    emailVerified: true,
    displayName: profile.name
  });
  profile.uid = created.uid;
});

test.afterAll(async () => {
  const existing = await emulatorAuth.getUserByEmail(email).catch(() => null);
  if (existing) {
    await emulatorAuth.deleteUser(existing.uid);
  }
  await deleteApp(adminApp);
});

test("switches Parcial and Pulmão in one click and clears the active choice", async ({
  page
}) => {
  await page.route("**/api/clients*", (route) =>
    route.fulfill(
      json({
        ok: true,
        data: { items: [], nextCursor: null, incomplete: false }
      })
    )
  );
  await page.route("**/api/events?*", (route) =>
    route.fulfill(
      json({
        ok: true,
        data: { items: [], nextCursor: null, incomplete: false }
      })
    )
  );

  await login(page);
  await page.goto("/events");

  const createForm = page
    .getByRole("heading", { name: "Novo lançamento" })
    .locator("..");
  const partial = createForm.getByRole("checkbox", { name: /^Parcial/ });
  const buffer = createForm.getByRole("checkbox", { name: /^Pulmão/ });
  const definedExit = createForm.locator(".container-result-line");

  await partial.click();
  await expect(partial).toBeChecked();
  await expect(buffer).not.toBeChecked();
  await expect(definedExit).toContainText("Parcial");

  await buffer.click();
  await expect(partial).not.toBeChecked();
  await expect(buffer).toBeChecked();
  await expect(definedExit).toContainText("Pulmão");

  await partial.click();
  await expect(partial).toBeChecked();
  await expect(buffer).not.toBeChecked();
  await expect(definedExit).toContainText("Parcial");

  await partial.click();
  await expect(partial).not.toBeChecked();
  await expect(buffer).not.toBeChecked();
  await expect(definedExit).toContainText("Cheio");
});
