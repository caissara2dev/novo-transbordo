import { expect, Page, test } from "@playwright/test";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const projectId = "demo-transbordo-e2e";
const email = "display-privacy.e2e@example.com";
const emulatorCredential = "local-emulator-only";
const adminApp = initializeApp({ projectId }, "playwright-display-privacy-e2e");
const emulatorAuth = getAuth(adminApp);

let profile = {
  uid: "",
  email,
  name: "Display Privacy E2E",
  role: "DISPLAY",
  approved: true,
  active: true,
  createdAt: null,
  updatedAt: null,
  approvedAt: null,
  approvedByUid: null,
  approvedByEmail: null
};

const clients = Array.from({ length: 9 }, (_, index) => ({
  clientId: `client-${index + 1}`,
  clientName: `Cliente Real ${index + 1}`,
  finalizedToday: 9 - index,
  openNow: index % 3
}));

const overview = {
  operationalDate: "2026-09-04",
  generatedAt: "2026-09-04T15:00:00.000Z",
  finalizedTotal: 45,
  averageProductiveMinutes: 27.5,
  openContainers: {
    total: 9,
    partial: 3,
    buffer: 3,
    blendPartial: 3
  },
  clients
};

function json(body: unknown, status = 200) {
  return {
    status,
    contentType: "application/json",
    body: JSON.stringify(body)
  };
}

async function mockSession(page: Page): Promise<void> {
  await page.route("**/api/auth/sync", (route) =>
    route.fulfill(json({ ok: true, data: { profile } }))
  );
  await page.route("**/api/me", (route) =>
    route.fulfill(
      json({
        ok: true,
        data: {
          profile,
          approvalContactPhone: null
        }
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
  await expect(page).toHaveURL(/\/display$/);
}

test.describe.configure({ mode: "serial" });

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
  profile = { ...profile, uid: created.uid };
});

test.afterAll(async () => {
  const existing = await emulatorAuth.getUserByEmail(email).catch(() => null);
  if (existing) {
    await emulatorAuth.deleteUser(existing.uid);
  }
  await deleteApp(adminApp);
});

test("toggles client names locally and resets visibility after reload", async ({
  page
}) => {
  let overviewRequests = 0;

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.route("**/api/display/overview", (route) => {
    overviewRequests += 1;
    return route.fulfill(json({ ok: true, data: overview }));
  });

  await login(page);

  const privacyButton = page.getByRole("button", {
    name: "Privacidade dos nomes dos clientes"
  });
  await expect(page.getByText("Cliente Real 1", { exact: true })).toBeVisible();
  await expect(privacyButton).toHaveAttribute("aria-pressed", "false");
  await expect(privacyButton).toHaveAttribute("title", "Ocultar nomes dos clientes");
  await page.keyboard.press("Tab");
  await expect(privacyButton).toBeFocused();

  const requestsBeforeToggle = overviewRequests;
  await page.keyboard.press("Enter");

  await expect(privacyButton).toHaveAttribute("aria-pressed", "true");
  await expect(privacyButton).toHaveAttribute("title", "Exibir nomes dos clientes");
  await expect(page.getByText("Cliente Real 1", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Cliente 1", { exact: true })).toBeVisible();
  expect(overviewRequests).toBe(requestsBeforeToggle);

  await expect(page.getByText("Página 2 / 2", { exact: true })).toBeVisible({
    timeout: 12_000
  });
  await expect(page.getByText("Cliente 9", { exact: true })).toBeVisible();

  await privacyButton.click();
  await expect(page.getByText("Cliente Real 9", { exact: true })).toBeVisible();
  expect(overviewRequests).toBe(requestsBeforeToggle);

  await page.reload();
  await expect(page.getByText("Cliente Real 1", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Privacidade dos nomes dos clientes" })
  ).toHaveAttribute("aria-pressed", "false");
});

test("keeps the Full HD layout stable when data is empty and then stale", async ({
  page
}) => {
  test.setTimeout(50_000);
  let failRefresh = false;

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.route("**/api/display/overview", (route) => {
    if (failRefresh) {
      return route.fulfill(
        json(
          {
            ok: false,
            error: {
              code: "INTERNAL_ERROR",
              message: "Indisponível no teste"
            }
          },
          503
        )
      );
    }

    return route.fulfill(
      json({
        ok: true,
        data: {
          ...overview,
          finalizedTotal: 0,
          averageProductiveMinutes: null,
          openContainers: {
            total: 0,
            partial: 0,
            buffer: 0,
            blendPartial: 0
          },
          clients: []
        }
      })
    );
  });

  await login(page);
  await expect(page.getByText("Sem movimentação registrada")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Privacidade dos nomes dos clientes" })
  ).toBeVisible();

  const dimensions = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth);

  failRefresh = true;
  await expect(
    page.getByText("Dados desatualizados — mantendo a última leitura válida")
  ).toBeVisible({ timeout: 35_000 });
  await expect(page.getByText("Sem movimentação registrada")).toBeVisible();
});
