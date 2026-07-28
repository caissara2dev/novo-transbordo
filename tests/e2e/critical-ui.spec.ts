import { expect, Page, test } from "@playwright/test";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const projectId = "demo-transbordo-e2e";
const email = "admin.e2e@example.com";
const emulatorCredential = "local-emulator-only";
const adminApp = initializeApp({ projectId }, "playwright-e2e");
const emulatorAuth = getAuth(adminApp);

const profile = {
  uid: "",
  email,
  name: "Admin E2E",
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
    route.fulfill(
      json({
        ok: true,
        data: { profile },
        profile
      })
    )
  );
  await page.route("**/api/me", (route) =>
    route.fulfill(
      json({
        ok: true,
        data: {
          profile,
          approvalContactPhone: null
        },
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
  await expect(
    page.getByRole("button", { name: "Abrir menu" })
  ).toBeVisible();
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
    displayName: "Admin E2E"
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

test("drawer is inert while closed, traps focus and restores it after Escape", async ({
  page
}) => {
  await login(page);

  const trigger = page.getByRole("button", { name: "Abrir menu" });
  const drawer = page.locator("#app-navigation");
  await expect(drawer).toHaveAttribute("aria-hidden", "true");
  await expect(drawer).toHaveAttribute("inert", "");

  await trigger.click();
  await expect(drawer).toHaveAttribute("aria-hidden", "false");
  await expect(drawer).not.toHaveAttribute("inert", "");
  await expect(
    page.getByRole("button", { name: "Fechar menu" }).last()
  ).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(drawer).toHaveAttribute("aria-hidden", "true");
  await expect(drawer).toHaveAttribute("inert", "");
  await expect(trigger).toBeFocused();
});

test("editing report draft filters does not refetch until Apply", async ({
  page
}) => {
  let overviewRequests = 0;
  let drilldownRequests = 0;
  const overviewUrls: string[] = [];
  const drilldownUrls: string[] = [];
  const overview = {
    filtersApplied: {
      dateFrom: "2026-07-22",
      dateTo: "2026-07-28",
      granularity: "day",
      includeDeleted: false
    },
    kpis: {
      totalMinutes: { current: 30, previous: 20, deltaPercent: 50 },
      productiveMinutes: { current: 20, previous: 10, deltaPercent: 100 },
      idleMinutes: { current: 10, previous: 10, deltaPercent: 0 },
      productiveRateMinutes: {
        current: 66.67,
        previous: 50,
        deltaPercent: 33.34
      },
      totalEvents: { current: 2, previous: 1, deltaPercent: 100 },
      productiveEvents: { current: 1, previous: 1, deltaPercent: 0 },
      productiveRateEvents: {
        current: 50,
        previous: 100,
        deltaPercent: -50
      },
      avgProductiveTransbordoMinutes: {
        current: 20,
        previous: 10,
        deltaPercent: 100
      }
    },
    charts: {
      productiveVsIdleByPump: [],
      idleByCategoryMinutes: [],
      idleByCategoryCount: [],
      trendSeries: [],
      shiftDistribution: []
    },
    audit: { editedActions: 0, deletedActions: 0 },
    totals: { processedCurrent: 2, processedComparisonWindow: 3 },
    limits: { maxPeriodDays: 90, maxEventsProcessed: 10_000 },
    warnings: []
  };
  const drilldown = {
    source: "kpi",
    rows: [],
    nextCursor: null,
    summary: { totalRows: 0, returnedRows: 0 }
  };

  await page.route("**/api/reports/overview?*", (route) => {
    overviewRequests += 1;
    overviewUrls.push(route.request().url());
    return route.fulfill(json({ ok: true, data: overview, ...overview }));
  });
  await page.route("**/api/reports/drilldown?*", (route) => {
    drilldownRequests += 1;
    drilldownUrls.push(route.request().url());
    return route.fulfill(json({ ok: true, data: drilldown, ...drilldown }));
  });
  await page.route("**/api/clients*", (route) =>
    route.fulfill(json({ ok: true, data: { items: [] }, items: [] }))
  );
  await page.route("**/api/containers*", (route) =>
    route.fulfill(json({ ok: true, data: { items: [] }, items: [] }))
  );

  await login(page);
  await page.goto("/reports");
  await expect(
    page.getByRole("heading", { name: "Relatórios V2" })
  ).toBeVisible();
  await expect.poll(() => overviewRequests).toBe(1);
  await expect.poll(() => drilldownRequests).toBe(1);

  await page.getByLabel("Bomba").selectOption("BOMBA_2");
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
  expect(overviewRequests).toBe(1);
  expect(drilldownRequests).toBe(1);

  await page.getByRole("button", { name: "Aplicar filtros" }).click();
  await expect.poll(() => overviewRequests).toBe(2);
  await expect.poll(() => drilldownRequests).toBe(2);
  expect(overviewUrls.at(-1)).toContain("pump=BOMBA_2");
  expect(drilldownUrls.at(-1)).toContain("pump=BOMBA_2");
});

test("event history loads cursor pages without duplicate rows", async ({
  page
}) => {
  const makeEvent = (id: string, notes: string) => ({
    id,
    pump: "BOMBA_1",
    shiftDate: "2026-07-28",
    shiftType: "T1",
    startTime: "08:00",
    endTime: "08:30",
    startAt: "2026-07-28T11:00:00.000Z",
    endAt: "2026-07-28T11:30:00.000Z",
    durationMinutes: 30,
    category: "OUTROS",
    origin: "MANUAL",
    clientId: null,
    clientNameSnapshot: null,
    plate: null,
    container: null,
    containerStatus: null,
    containerReason: null,
    notes,
    createdAt: "2026-07-28T11:30:00.000Z",
    updatedAt: "2026-07-28T11:30:00.000Z",
    createdByEmail: email,
    updatedByEmail: email,
    deleted: false,
    previousContainerPassages: []
  });
  const requestedCursors: Array<string | null> = [];

  await page.route("**/api/clients*", (route) =>
    route.fulfill(
      json({
        ok: true,
        data: { items: [], nextCursor: null, incomplete: false }
      })
    )
  );
  await page.route("**/api/events?*", (route) => {
    const cursor = new URL(route.request().url()).searchParams.get(
      "cursor"
    );
    requestedCursors.push(cursor);
    const data = cursor
      ? {
          items: [
            makeEvent("event-2", "overlap-updated"),
            makeEvent("event-3", "second-page-marker")
          ],
          nextCursor: null,
          incomplete: false
        }
      : {
          items: [
            makeEvent("event-1", "first-page-marker"),
            makeEvent("event-2", "overlap-stale")
          ],
          nextCursor: "opaque/cursor+token=",
          incomplete: false
        };

    return route.fulfill(json({ ok: true, data }));
  });

  await login(page);
  await page.goto("/events");
  await expect(page.getByText(/first-page-marker/)).toBeVisible();
  await page.getByRole("button", { name: "Carregar mais" }).click();

  await expect(page.getByText(/second-page-marker/)).toBeVisible();
  await expect(page.getByText(/overlap-updated/)).toBeVisible();
  await expect(page.getByText(/overlap-stale/)).toHaveCount(0);
  await expect(page.locator(".history-item")).toHaveCount(3);
  expect(requestedCursors).toEqual([null, "opaque/cursor+token="]);
});

test("keeps the saved launch and existing history clear when history refresh fails", async ({
  page
}) => {
  const existingEvent = {
    id: "event-existing",
    pump: "BOMBA_1",
    shiftDate: "2026-07-28",
    shiftType: "MANHA",
    startTime: "06:00",
    endTime: "06:10",
    startAt: "2026-07-28T09:00:00.000Z",
    endAt: "2026-07-28T09:10:00.000Z",
    durationMinutes: 10,
    category: "OUTROS",
    origin: "MANUAL",
    clientId: null,
    clientNameSnapshot: null,
    plate: null,
    container: null,
    containerStatus: null,
    containerReason: null,
    notes: "existing-history-marker",
    createdAt: "2026-07-28T09:10:00.000Z",
    updatedAt: "2026-07-28T09:10:00.000Z",
    createdByEmail: email,
    updatedByEmail: email,
    deleted: false,
    previousContainerPassages: []
  };
  let historyRequests = 0;
  let createRequests = 0;

  await page.route("**/api/clients*", (route) =>
    route.fulfill(
      json({
        ok: true,
        data: { items: [], nextCursor: null, incomplete: false }
      })
    )
  );
  await page.route("**/api/events?*", (route) => {
    historyRequests += 1;

    if (historyRequests === 1) {
      return route.fulfill(
        json({
          ok: true,
          data: {
            items: [existingEvent],
            nextCursor: null,
            incomplete: false
          }
        })
      );
    }

    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "Erro inesperado."
        }
      })
    });
  });
  await page.route("**/api/events", (route) => {
    createRequests += 1;
    return route.fulfill(
      json({
        ok: true,
        data: {
          item: {
            ...existingEvent,
            id: "event-created",
            notes: "created-event",
            warnings: []
          }
        }
      })
    );
  });

  await login(page);
  await page.goto("/events");
  await expect(page.getByText("existing-history-marker")).toBeVisible();

  const createForm = page
    .getByRole("heading", { name: "Novo lançamento" })
    .locator("..");
  await createForm.getByLabel("Horário início").fill("06:10");
  await createForm.getByLabel("Horário fim").fill("06:20");
  await createForm
    .getByRole("button", { name: "Registrar ociosidade" })
    .click();
  await createForm.getByLabel("Observações").fill("created-event");
  await createForm
    .getByRole("button", { name: "Salvar lançamento" })
    .click();

  await expect(
    page.getByText("Lançamento salvo com sucesso.")
  ).toBeVisible();
  await expect(
    page.getByText(
      "O histórico está temporariamente indisponível. O lançamento foi salvo e não precisa ser enviado novamente. Atualize a página em alguns minutos."
    )
  ).toBeVisible();
  await expect(page.getByText("Erro inesperado.")).toHaveCount(0);
  await expect(page.getByText("existing-history-marker")).toBeVisible();
  expect(createRequests).toBe(1);
  expect(historyRequests).toBe(2);
});
