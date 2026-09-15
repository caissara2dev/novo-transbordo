import { expect, Page, test } from "@playwright/test";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const adminApp = initializeApp({ projectId: "demo-transbordo-e2e" }, "display-polling-e2e");
const emulatorAuth = getAuth(adminApp);
const email = "display-polling@example.com";
const password = "local-emulator-only";
let uid = "";
const overview = {
  operationalDate: "2026-09-14",
  generatedAt: "2026-09-14T12:00:00.000Z",
  finalizedTotal: 12,
  averageProductiveMinutes: 25,
  openContainers: { total: 9, partial: 4, buffer: 3, blendPartial: 2 },
  clients: Array.from({ length: 9 }, (_, i) => ({ clientId: `client-${i}`, clientName: `Empresa teste ${i + 1}`, finalizedToday: i, openNow: 1 }))
};

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const user = await emulatorAuth.createUser({ email, password, emailVerified: true });
  uid = user.uid;
});
test.afterAll(async () => {
  if (uid) await emulatorAuth.deleteUser(uid);
  await deleteApp(adminApp);
});

async function login(page: Page) {
  const profile = { uid, email, name: "Display teste", role: "DISPLAY", approved: true, active: true };
  await page.route("**/api/auth/sync", (route) => route.fulfill({ json: { ok: true, data: { profile }, profile } }));
  await page.route("**/api/me", (route) => route.fulfill({ json: { ok: true, data: { profile, approvalContactPhone: null }, profile } }));
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Senha").fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/display$/);
}
async function visibility(page: Page, hidden: boolean) {
  await page.evaluate((value) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

test("keeps indicators, clock, rotation and privacy while reducing requests", async ({ page }) => {
  let requests = 0;
  await page.clock.install();
  await page.route("**/api/display/overview", (route) => { requests++; return route.fulfill({ json: { ok: true, data: overview } }); });
  await login(page);
  await expect(page.getByRole("heading", { name: "Controle Transbordo" })).toBeVisible();
  expect(requests).toBe(1);
  await expect(page.locator(".display-metric-primary strong")).toHaveText("12");
  await expect(page.locator(".display-metric-time strong")).toHaveText("25 min");
  await expect(page.locator(".display-open-total strong")).toHaveText("9");
  await expect(page.locator(".display-operational-date strong")).toHaveText("14/09/2026");
  const clock = await page.locator(".display-clock > strong").textContent();
  await page.getByRole("button", { name: "Privacidade dos nomes dos clientes" }).click();
  await expect(page.getByRole("cell", { name: "Cliente 1", exact: true })).toBeVisible();
  await page.clock.runFor(11_000);
  await expect(page.locator(".display-clock > strong")).not.toHaveText(clock!);
  await expect(page.getByRole("cell", { name: "Cliente 9", exact: true })).toBeVisible();
  expect(requests).toBe(1);
  await visibility(page, true);
  await page.clock.runFor(30_000);
  await visibility(page, false);
  await page.clock.runFor(1);
  await expect.poll(() => requests).toBe(2);
  await expect(page.getByRole("button", { name: "Privacidade dos nomes dos clientes" })).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: "tmp/display-v2.5.1.png", fullPage: true });
});

test("pauses hidden tabs, throttles rapid returns and keeps a single timer", async ({ page }) => {
  let requests = 0;
  await page.clock.install();
  await page.route("**/api/display/overview", (route) => { requests++; return route.fulfill({ json: { ok: true, data: overview } }); });
  await login(page);
  await expect(page.getByRole("heading", { name: "Controle Transbordo" })).toBeVisible();
  await visibility(page, true);
  await page.clock.runFor(600_000);
  expect(requests).toBe(1);
  await visibility(page, false);
  await page.clock.runFor(1);
  await expect.poll(() => requests).toBe(2);
  await expect(page.locator(".display-stale-banner")).toHaveCount(0);
  for (let i = 0; i < 5; i++) { await visibility(page, true); await visibility(page, false); }
  await page.clock.runFor(29_000);
  expect(requests).toBe(2);
  await page.clock.runFor(1_001);
  await expect.poll(() => requests).toBe(3);
  await page.clock.runFor(119_000);
  expect(requests).toBe(3);
  await page.clock.runFor(1_001);
  await expect.poll(() => requests).toBe(4);
});

test("keeps last good data after an error and recovers on the next cycle", async ({ page }) => {
  let requests = 0;
  await page.clock.install();
  await page.route("**/api/display/overview", (route) => {
    requests++;
    return requests === 2
      ? route.fulfill({ status: 500, json: { ok: false, error: { code: "INTERNAL_ERROR", message: "Falha simulada" } } })
      : route.fulfill({ json: { ok: true, data: { ...overview, finalizedTotal: requests === 1 ? 12 : 13 } } });
  });
  await login(page);
  await expect(page.locator(".display-metric-primary strong")).toHaveText("12");
  await page.clock.runFor(120_001);
  await expect(page.locator(".display-stale-banner")).toContainText("Dados desatualizados");
  await expect(page.locator(".display-metric-primary strong")).toHaveText("12");
  await visibility(page, true); await visibility(page, false);
  await page.clock.runFor(119_000);
  expect(requests).toBe(2);
  await page.clock.runFor(1_001);
  await expect(page.locator(".display-metric-primary strong")).toHaveText("13");
  await expect(page.locator(".display-stale-banner")).toHaveCount(0);
});

test("initial timeout leaves loading state and recovers without overlapping calls", async ({ page }) => {
  let requests = 0;
  await page.clock.install();
  await page.route("**/api/display/overview", (route) => {
    requests++;
    if (requests === 1) return;
    return route.fulfill({ json: { ok: true, data: overview } });
  });
  await login(page);
  await expect.poll(() => requests).toBe(1);
  await page.clock.runFor(30_001);
  await expect(page.getByRole("heading", { name: "Conexão indisponível" })).toBeVisible();
  await page.clock.runFor(119_000);
  expect(requests).toBe(1);
  await page.clock.runFor(1_001);
  await expect(page.getByRole("heading", { name: "Controle Transbordo" })).toBeVisible();
  expect(requests).toBe(2);
});
