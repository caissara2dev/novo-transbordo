import { expect, Page, test } from "@playwright/test";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const projectId = "demo-transbordo-e2e";
const email = "container-transfer.e2e@example.com";
const emulatorCredential = "local-emulator-only";
const adminApp = initializeApp({ projectId }, "container-transfer-ui-e2e");
const emulatorAuth = getAuth(adminApp);

const profile = {
  uid: "",
  email,
  name: "Container Transfer E2E",
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
        data: {
          profile,
          approvalContactPhone: null,
          containerTransfersEnabled: true
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
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const existing = await emulatorAuth.getUserByEmail(email).catch(() => null);
  if (existing) await emulatorAuth.deleteUser(existing.uid);
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
  if (existing) await emulatorAuth.deleteUser(existing.uid);
  await deleteApp(adminApp);
});

const originFixtures = [
  {
    container: "TSTU 250001-9",
    status: "BUFFER",
    clientId: "client-1",
    clientNameSnapshot: "Cliente Alfa",
    version: 7,
    cycleId: "buffer-current-cycle"
  },
  {
    container: "TSTU 250003-0",
    status: "PARTIAL",
    clientId: "client-1",
    clientNameSnapshot: "Cliente Alfa",
    version: 4,
    cycleId: "partial-current-cycle"
  }
];

async function emptyForm(page: Page) {
  await page.route("**/api/clients*", (route) =>
    route.fulfill(
      json({
        ok: true,
        data: {
          items: [{ id: "client-1", name: "Cliente Alfa", active: true }],
          nextCursor: null
        }
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
  await page.route("**/api/containers/lookup?*", (route) =>
    route.fulfill(
      json({
        ok: true,
        data: {
          current: null,
          availableStatuses: ["FULL", "PARTIAL", "BUFFER"],
          requiresNewCycleConfirmation: false
        }
      })
    )
  );
  await login(page);
  await page.goto("/events");
  return page.getByRole("heading", { name: "Novo lançamento" }).locator("..");
}

function sourcePage(items = originFixtures, nextCursor: string | null = null) {
  return json({ ok: true, data: { items, nextCursor, incomplete: false } });
}

test("automatically recognizes a source, requires selection and invalidates the inherited client", async ({
  page
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  let searches = 0;
  await page.route("**/api/containers?*", (route) => {
    const params = new URL(route.request().url()).searchParams;
    expect(params.get("scope")).toBe("transfer-source");
    expect(params.get("limit")).toBe("20");
    searches++;
    return route.fulfill(
      sourcePage(
        originFixtures.filter(
          (item) =>
            item.container.replace(/[\s-]/g, "") !==
            params.get("excludeContainer")
        )
      )
    );
  });
  const form = await emptyForm(page);
  const origin = form.getByLabel("Placa ou container de origem *");
  await origin.fill("tst");
  await expect(form.getByText("A identificar", { exact: true })).toBeVisible();
  expect(searches).toBe(0);
  await origin.fill("t s t-u");
  await expect(origin).toHaveValue("t s t-u");
  await expect(
    form.getByRole("option", { name: /TSTU 250003-0.*Parcial/ })
  ).toBeVisible();
  await expect(form.getByLabel("Cliente *")).toHaveValue("");
  await origin.press("ArrowDown");
  await origin.press("ArrowDown");
  await origin.press("Enter");
  await expect(origin).toHaveValue("TSTU 250003-0");
  await expect(form.getByLabel("Cliente *")).toHaveValue("client-1");
  await expect(form.getByLabel("Cliente *")).toBeDisabled();
  await form.getByLabel("Não, restará carga").check();
  await form.getByLabel("Container de destino *").fill("TSTU2500024");
  await expect(page.locator("[data-nextjs-dialog]")).toHaveCount(0);
  await form.screenshot({ path: "tmp/origin-auto-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await form.screenshot({ path: "tmp/origin-auto-mobile.png" });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
  expect(pageErrors).toEqual([]);
  await form.getByLabel("Container de destino *").fill("TSTU2500030");
  await expect(form.getByRole("alert")).toContainText("Origem e destino");
  await expect(form.getByLabel("Cliente *")).toHaveValue("");
  await expect(form.getByLabel("Não, restará carga")).toHaveCount(0);
  await origin.fill("abc1d23");
  await expect(origin).toHaveValue("abc1d23");
  await expect(form.getByText("Carreta identificada")).toBeVisible();
  await expect(form.getByLabel("Cliente *")).toBeEnabled();
});

test("preserves pasted text and cursor while correcting between truck, unknown and container", async ({
  page
}) => {
  await page.route("**/api/containers?*", (route) =>
    route.fulfill(sourcePage())
  );
  const form = await emptyForm(page);
  const origin = form.getByLabel("Placa ou container de origem *");
  await origin.fill("tstu2500019");
  await expect(origin).toHaveValue("tstu2500019");
  await origin.evaluate((element: HTMLInputElement) =>
    element.setSelectionRange(3, 4)
  );
  await origin.press("4");
  await expect(origin).toHaveValue("tst42500019");
  expect(
    await origin.evaluate((element: HTMLInputElement) => element.selectionStart)
  ).toBe(4);
  await expect(form.getByText("Carreta identificada")).toBeVisible();
  await origin.press("Backspace");
  await origin.press("Backspace");
  await expect(origin).toHaveValue("ts2500019");
  await expect(form.getByText("A identificar", { exact: true })).toBeVisible();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(() => navigator.clipboard.writeText("tstu-2500019"));
  await origin.fill("");
  await origin.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
  await expect(origin).toHaveValue("tstu-2500019");
  await expect(form.getByText("Container identificado")).toBeVisible();
  await origin.press("Escape");
  await expect(form.getByRole("listbox")).toHaveCount(0);
});

test("waits for the destination version and permits retry after a failed lookup", async ({
  page
}) => {
  await page.route("**/api/containers?*", (route) =>
    route.fulfill(sourcePage())
  );
  await page.route("**/api/events/gap-preview", (route) =>
    route.fulfill(
      json({
        ok: true,
        data: {
          toleranceMinutes: 10,
          gapVersion: "gap-current",
          uncoveredSegments: [],
          uncoveredMinutes: 0,
          requiresJustification: false,
          reconciliations: []
        }
      })
    )
  );
  const form = await emptyForm(page);
  let releaseLookup!: () => void;
  const waiting = new Promise<void>((resolve) => {
    releaseLookup = resolve;
  });
  let fail = true;
  await page.route("**/api/containers/lookup?*", async (route) => {
    if (fail) {
      await waiting;
      fail = false;
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: { code: "INTERNAL_ERROR", message: "Destino indisponível" } })
      });
    }
    return route.fulfill(
      json({
        ok: true,
        data: {
          current: null,
          availableStatuses: ["FULL", "PARTIAL", "BUFFER"],
          requiresNewCycleConfirmation: false
        }
      })
    );
  });
  await form.getByLabel("Placa ou container de origem *").fill("TSTU");
  await form.getByRole("option", { name: /TSTU 250003-0/ }).click();
  await form.getByLabel("Não, restará carga").check();
  await form.getByLabel("Horário início").fill("06:00");
  await form.getByLabel("Horário fim").fill("06:20");
  await form.getByLabel("Container de destino *").fill("TSTU2500024");
  const save = form.getByRole("button", { name: "Salvar lançamento" });
  await expect(form.getByText("Consultando…", { exact: true })).toBeVisible();
  await expect(save).toBeDisabled();
  releaseLookup();
  await expect(form.getByText("Destino indisponível")).toBeVisible();
  await expect(save).toBeDisabled();
  await form.getByRole("button", { name: "Tentar novamente" }).click();
  await expect(save).toBeEnabled();
  let submittedCycle: string | null = null;
  await page.route("**/api/events", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    submittedCycle = route.request().postDataJSON().expectedSourceContainerCycleId;
    return route.fulfill({
      status: 409, contentType: "application/json",
      body: JSON.stringify({ ok: false, error: { code: "CONFLICT", message: "O horário não pertence ao ciclo de origem selecionado." } })
    });
  });
  await save.click();
  await expect.poll(() => submittedCycle).toBe("partial-current-cycle");
  await expect(page.getByText("O horário não pertence ao ciclo de origem selecionado.")).toBeVisible();
});

test("supports pagination, retry, empty results and ignores a stale response", async ({
  page
}) => {
  let fail = true;
  await page.route("**/api/containers?*", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get("query") === "MSCU") {
      await new Promise((resolve) => setTimeout(resolve, 650));
      await route
        .fulfill(
          sourcePage([{ ...originFixtures[0], container: "MSCU 663987-0" }])
        )
        .catch(() => {});
      return;
    }
    if (params.get("query") === "XXXX") {
      await route.fulfill(sourcePage([]));
      return;
    }
    if (fail) {
      fail = false;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Consulta indisponível" })
      });
      return;
    }
    await route.fulfill(
      params.has("cursor")
        ? sourcePage([originFixtures[1]])
        : sourcePage([originFixtures[0]], "next-page")
    );
  });
  const form = await emptyForm(page);
  const origin = form.getByLabel("Placa ou container de origem *");
  await origin.fill("TSTU");
  await expect(form.getByRole("alert")).toBeVisible();
  await form.getByRole("button", { name: "Tentar novamente" }).click();
  await expect(
    form.getByRole("option", { name: /TSTU 250001-9/ })
  ).toBeVisible();
  await form.getByRole("button", { name: "Carregar mais" }).click();
  await expect(
    form.getByRole("option", { name: /TSTU 250003-0/ })
  ).toBeVisible();
  await expect(form.getByLabel("Cliente *")).toHaveValue("");
  const pending = page.waitForRequest((request) =>
    request.url().includes("query=MSCU")
  );
  await origin.fill("MSCU");
  await pending;
  await origin.fill("XXXX");
  await expect(
    form.getByText("Nenhum Pulmão ou Parcial aberto foi encontrado.")
  ).toBeVisible();
  await expect(form.getByRole("option", { name: /MSCU/ })).toHaveCount(0);
  await expect(form.getByLabel("Cliente *")).toHaveValue("");
});

test("shows the source instead of a plate in global and container histories", async ({
  page
}) => {
  const transfer = {
    id: "event-transfer",
    pump: "BOMBA_1",
    shiftDate: "2026-08-13",
    shiftType: "MANHA",
    startTime: "08:00",
    endTime: "08:20",
    startAt: "2026-08-13T11:00:00.000Z",
    endAt: "2026-08-13T11:20:00.000Z",
    durationMinutes: 20,
    category: "PRODUTIVO",
    origin: "MANUAL",
    clientId: "client-1",
    clientNameSnapshot: "Cliente Alfa",
    plate: null,
    container: "MATU7654321",
    containerStatus: "FULL",
    containerReason: null,
    loadSourceType: "BUFFER_CONTAINER",
    sourceContainer: "ABCU1234560",
    sourceContainerEmptied: true,
    sourceContainerStateVersion: 5,
    sourceContainerCycleId: "historical-source-cycle",
    notes: null,
    createdAt: "2026-08-13T11:20:00.000Z",
    updatedAt: "2026-08-13T11:20:00.000Z",
    createdByEmail: email,
    updatedByEmail: email,
    deleted: false,
    previousContainerPassages: []
  };

  await page.route("**/api/clients*", (route) =>
    route.fulfill(
      json({
        ok: true,
        data: {
          items: [{ id: "client-1", name: "Cliente Alfa", active: true }],
          nextCursor: null,
          incomplete: false
        }
      })
    )
  );
  await page.route("**/api/containers/lookup?*", (route) =>
    route.fulfill(
      json({
        ok: true,
        data: {
          container: "ABCU 123456-0",
          current: {
            container: "ABCU 123456-0",
            status: "TRANSFER_EMPTIED",
            clientId: "client-1",
            version: 9,
            cycleId: "a-newer-source-cycle"
          },
          availableStatuses: ["FULL", "PARTIAL", "BUFFER"],
          requiresNewCycleConfirmation: false
        }
      })
    )
  );
  await page.route("**/api/events/gap-preview", (route) =>
    route.fulfill(
      json({
        ok: true,
        data: {
          toleranceMinutes: 10,
          gapVersion: "gap-current",
          uncoveredSegments: [],
          uncoveredMinutes: 0,
          requiresJustification: false,
          reconciliations: []
        }
      })
    )
  );
  let editedSourceVersion: number | null = null;
  let editedSourceCycle: string | null = null;
  await page.route("**/api/events/event-transfer", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const body = route.request().postDataJSON();
    editedSourceVersion = body.expectedSourceContainerStateVersion;
    editedSourceCycle = body.expectedSourceContainerCycleId;
    return route.fulfill(json({ ok: true, data: transfer }));
  });
  await page.route("**/api/events?*", (route) =>
    route.fulfill(
      json({
        ok: true,
        data: { items: [transfer], nextCursor: null, incomplete: false }
      })
    )
  );

  await login(page);
  await page.goto("/events");
  const historyItem = page.locator(".history-item").filter({
    hasText: "MATU7654321"
  });
  await expect(historyItem).toContainText("Container de origem: ABCU1234560");
  await expect(historyItem).toContainText("Container de destino: MATU7654321");
  await expect(historyItem).not.toContainText("Placa:");

  await historyItem.getByRole("button", { name: "Editar" }).click();
  await expect(
    page.getByRole("heading", { name: "Editar lançamento" })
  ).toBeVisible();
  const editPanel = page.getByTestId("event-edit-panel");
  await expect(
    editPanel.getByLabel("Placa ou container de origem *")
  ).toHaveValue("ABCU1234560");
  await editPanel
    .getByRole("button", { name: "Atualizar estado da origem" })
    .click();
  await expect(editPanel.getByLabel("Sim, foi esvaziado")).not.toBeChecked();
  await editPanel.getByLabel("Sim, foi esvaziado").check();
  await page.getByRole("button", { name: "Salvar edição" }).click();
  await expect.poll(() => editedSourceVersion).toBe(9);
  expect(editedSourceCycle).toBe("historical-source-cycle");

  await page.route("**/api/containers/history?*", (route) =>
    route.fulfill(
      json({
        ok: true,
        data: {
          items: [
            {
              ...transfer,
              status: "TRANSFER_EMPTIED",
              containerRole: "SOURCE",
              relatedContainer: "MATU7654321"
            }
          ]
        }
      })
    )
  );
  await page.route("**/api/containers?*", (route) => {
    return route.fulfill(
      json({
        ok: true,
        data: {
          items: [
            {
              container: "ABCU1234560",
              status: "TRANSFER_EMPTIED",
              reason: null,
              cycleId: "cycle-source",
              latestEventId: transfer.id,
              previousEventId: null,
              clientId: "client-1",
              clientNameSnapshot: "Cliente Alfa",
              plate: null,
              pump: "BOMBA_1",
              latestEventRole: "SOURCE",
              relatedContainer: "MATU7654321",
              operationalAt: transfer.endAt,
              eventCreatedAt: transfer.createdAt,
              version: 8
            }
          ],
          nextCursor: null,
          incomplete: false
        }
      })
    );
  });

  await page.goto("/containers");
  await page.getByRole("button", { name: /ABCU1234560/ }).click();
  const timeline = page.locator(".container-timeline-event");
  await expect(timeline).toContainText("Destino MATU7654321");
  await expect(timeline).toContainText(
    "Container de origem esvaziado pela transferência."
  );
});
