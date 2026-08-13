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

test("selects a buffer source, locks its client and clears it when returning to truck", async ({
  page
}) => {
  const buffer = {
    container: "ABCU 123456-0",
    status: "BUFFER",
    reason: "Reserva operacional",
    cycleId: "cycle-source",
    latestEventId: "event-source",
    previousEventId: null,
    clientId: "client-1",
    clientNameSnapshot: "Cliente Alfa",
    plate: "ABC1D23",
    pump: "BOMBA_1",
    operationalAt: "2026-08-13T12:00:00.000Z",
    eventCreatedAt: "2026-08-13T12:00:00.000Z",
    version: 7
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
  await page.route("**/api/events?*", (route) =>
    route.fulfill(
      json({
        ok: true,
        data: { items: [], nextCursor: null, incomplete: false }
      })
    )
  );
  await page.route("**/api/containers/lookup?*", (route) =>
    route.fulfill(json({ ok: true, data: { current: null, passages: [] } }))
  );
  await page.route("**/api/containers?*", (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("scope")).toBe("open");
    expect(url.searchParams.get("status")).toBe("BUFFER");
    return route.fulfill(
      json({
        ok: true,
        data: { items: [buffer], nextCursor: null, incomplete: false }
      })
    );
  });

  await login(page);
  await page.goto("/events");

  const createForm = page
    .getByRole("heading", { name: "Novo lançamento" })
    .locator("..");
  await expect(createForm.getByLabel("Carreta")).toBeChecked();
  await createForm.getByLabel("Container pulmão").check();

  await expect(createForm.getByLabel("Placa *")).toHaveCount(0);
  await expect(createForm.getByLabel("Container de origem *")).toBeVisible();
  await createForm
    .getByLabel("Container de origem *")
    .selectOption("ABCU 123456-0");

  await expect(createForm.getByLabel("Cliente *")).toHaveValue("client-1");
  await expect(createForm.getByLabel("Cliente *")).toBeDisabled();
  await expect(
    createForm.getByText("O container de origem foi completamente esvaziado?")
  ).toBeVisible();
  await createForm.getByLabel("Não, continuará como pulmão").check();

  await createForm.getByLabel("Container *").fill("ABCU1234560");
  await expect(
    createForm.getByText("Origem e destino precisam ser containers diferentes.")
  ).toBeVisible();
  await expect(
    createForm.getByRole("button", { name: "Salvar lançamento" })
  ).toBeDisabled();

  await createForm.getByLabel("Carreta").check();
  await expect(createForm.getByLabel("Placa *")).toBeVisible();
  await expect(createForm.getByLabel("Container de origem *")).toHaveCount(0);
  await expect(createForm.getByLabel("Cliente *")).toBeEnabled();
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
            version: 9
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
  await page.route("**/api/events/event-transfer", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const body = route.request().postDataJSON();
    editedSourceVersion = body.expectedSourceContainerStateVersion;
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
  await expect(page.getByRole("heading", { name: "Editar lançamento" })).toBeVisible();
  await page.getByRole("button", { name: "Salvar edição" }).click();
  await expect.poll(() => editedSourceVersion).toBe(9);

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
