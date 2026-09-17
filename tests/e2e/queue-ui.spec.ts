import { expect, test, type Page } from "@playwright/test";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { applyQueueCommand, queueIssueAction, type QueueVisit } from "../../src/lib/domain/queue";
const app = initializeApp({ projectId: "demo-transbordo-e2e" }, "queue-ui-e2e");
const auth = getAuth(app);
const email = "queue.e2e@example.test";
const password = "local-emulator-only";
let uid = "";
const client = {
  id: "allog",
  name: "ALLOG",
  portalEnabled: true,
  usesSample: true,
};
const initial = {
  id: "demo",
  publicCode: "DEMO-01",
  plate: "ABC-1D23",
  driverName: "Motorista demonstração",
  carrierName: "Transportadora Demo",
  product: "Glicerina",
  originPlant: "Usina Demo",
  originInvoiceNumbers: "DEMO-NF-1",
  remittanceInvoiceNumber: "DEMO-NF-2",
  vehicleType: "Bitrem",
  clientId: "allog",
  clientName: "ALLOG",
  status: "AGUARDANDO_LIBERACAO",
  version: 2,
  booking: "BK-DEMO",
  sample: "",
  observation: "",
  usesSample: true,
  confirmedAtIso: "2026-09-10T12:00:00.000Z",
  updatedAtIso: "2026-09-10T12:00:00.000Z",
  updatedBy: "Line",
};
const json = (data: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(
    status === 200
      ? { ok: true, data }
      : { ok: false, error: { message: data, code: "CONFLICT" } },
  ),
});
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  const old = await auth.getUserByEmail(email).catch(() => null);
  if (old) await auth.deleteUser(old.uid);
  uid = (await auth.createUser({ email, password, emailVerified: true })).uid;
});
test.afterAll(async () => {
  if (uid) await auth.deleteUser(uid);
  await deleteApp(app);
});
for (const role of ["ANALYST", "CUSTOMER"] as const)
  test(`${role} lands on the right screen, saves through its API and preserves conflicts`, async ({
    page,
  }) => {
    const customer = role === "CUSTOMER";
    const base = customer ? "/api/customer/checkins" : "/api/checkins";
    let visit = { ...initial };
    let conflict = false;
    const writes: Record<string, unknown>[] = [];
    const profile = {
      uid,
      email,
      name: "Usuário Demo",
      role,
      clientId: customer ? "allog" : null,
      approved: true,
      active: true,
    };
    await page.route("**/api/me", (r) =>
      r.fulfill(
        json({ profile, checkinsEnabled: true, approvalContactPhone: null }),
      ),
    );
    await page.route("**/api/auth/sync", (r) => r.fulfill(json({ profile })));
    await page.route(`**${base}*`, (r) =>
      r.fulfill(json({ items: [visit], clients: [client], nextCursor: null })),
    );
    await page.route(`**${base}/demo`, async (r) => {
      if (r.request().method() === "PATCH") {
        const body = r.request().postDataJSON();
        writes.push(body);
        if (conflict)
          return r.fulfill(
            json(
              "Outra pessoa alterou esta visita. Seu preenchimento foi mantido.",
              409,
            ),
          );
        visit = {
          ...visit,
          ...body.command.shared,
          version: visit.version + 1,
        };
      }
      return r.fulfill(json({ item: visit }));
    });
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Senha").fill(password);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await expect(page).toHaveURL(
      customer ? /\/customer\/checkins$/ : /\/checkins$/,
    );
    await expect(
      page.getByRole("heading", {
        name: customer ? "Minhas cargas" : "Fila de check-ins",
        exact: true,
      }),
    ).toBeVisible();
    await page.getByLabel("Booking", { exact: true }).fill("BK-ATUALIZADO");
    await page
      .getByRole("button", { name: "Salvar alterações", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Salvar alterações", exact: true }),
    ).toBeDisabled();
    expect(writes[0]).toMatchObject({
      expectedVersion: 2,
      command: {
        kind: customer ? "SHARED" : "CLASSIFY",
        shared: { booking: "BK-ATUALIZADO" },
      },
    });
    if (customer) {
      await expect(page.getByText("Pendências internas")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Liberar para chamada" }),
      ).toHaveCount(0);
    } else {
      await expect(
        page.getByRole("button", { name: "Liberar para chamada" }),
      ).toBeEnabled();
    }
    conflict = true;
    await page.getByLabel("Booking", { exact: true }).fill("RASCUNHO");
    await page
      .getByRole("button", { name: "Salvar alterações", exact: true })
      .click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Outra pessoa" }),
    ).toBeVisible();
    await expect(page.getByLabel("Booking", { exact: true })).toHaveValue(
      "RASCUNHO",
    );
  });


async function interactiveQueue(page: Page, overrides: Partial<QueueVisit> = {}) {
  let visit = { ...initial, issues: [], revisions: [], driverPhone: "13996524561", ...overrides } as QueueVisit;
  let reject = false;
  const writes: any[] = [];
  const profile = { uid, email, name: "Analista Demo", role: "ANALYST", active: true, approved: true };
  await page.route("**/api/me", (r) => r.fulfill(json({ profile, checkinsEnabled: true, approvalContactPhone: null })));
  await page.route("**/api/auth/sync", (r) => r.fulfill(json({ profile })));
  await page.route("**/api/checkins", (r) => r.fulfill(json({ items: [visit], clients: [client], nextCursor: null })));
  await page.route("**/api/checkins/demo", (r) => {
    if (r.request().method() === "PATCH") {
      const body = r.request().postDataJSON(); writes.push(body);
      if (reject || body.expectedVersion !== visit.version) return r.fulfill(json("Não foi possível salvar esta alteração. Seu preenchimento foi mantido.", 409));
      const updated = applyQueueCommand(visit, body.command, [client]);
      visit = { ...updated, version: visit.version + 1, updatedBy: "Analista Demo", revisions: [{
        id: `revision-${visit.version}`, action: queueIssueAction(body.command) ?? "Informações atualizadas", actor: "Analista Demo",
        at: "2026-09-17T16:00:00.000Z", fields: [body.command.issue?.description ?? "Pendência"],
      }, ...(visit.revisions ?? [])] };
    }
    return r.fulfill(json({ item: visit }));
  });
  await page.goto("/login");
  await page.getByLabel("Email").fill(email); await page.getByLabel("Senha").fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Fila de check-ins", exact: true })).toBeVisible();
  return { writes, get: () => visit, fail: (value: boolean) => { reject = value; }, set: (next: QueueVisit) => { visit = next; } };
}

test("issues save immediately without submitting or losing the classification draft, including confirmed deletion", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await interactiveQueue(page);
  await page.getByLabel("Booking", { exact: true }).fill("RASCUNHO-LOCAL");
  await page.getByLabel("Nova pendência", { exact: true }).fill("Conferir nota nova");
  await page.getByRole("button", { name: "Adicionar", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Resolver pendência: Conferir nota nova" })).toBeVisible();
  expect(state.get().booking).toBe("BK-DEMO");
  await expect(page.getByLabel("Booking", { exact: true })).toHaveValue("RASCUNHO-LOCAL");
  await page.getByRole("checkbox", { name: "Resolver pendência: Conferir nota nova" }).click();
  await expect(page.getByRole("checkbox", { name: "Reabrir pendência: Conferir nota nova" })).toBeChecked();
  await page.getByRole("checkbox", { name: "Reabrir pendência: Conferir nota nova" }).click();
  await expect(page.getByRole("checkbox", { name: "Resolver pendência: Conferir nota nova" })).not.toBeChecked();
  await page.getByRole("button", { name: "Excluir pendência: Conferir nota nova" }).click();
  await page.getByRole("group", { name: "Confirmar exclusão da pendência" }).getByRole("button", { name: "Cancelar", exact: true }).click();
  expect(state.writes).toHaveLength(3);
  await expect(page.getByRole("checkbox", { name: "Resolver pendência: Conferir nota nova" })).toBeVisible();
  await page.getByRole("button", { name: "Excluir pendência: Conferir nota nova" }).click();
  await page.getByRole("button", { name: "Confirmar exclusão", exact: true }).click();
  await expect(page.getByText("Nenhuma pendência registrada.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Booking", { exact: true })).toHaveValue("RASCUNHO-LOCAL");
  expect(state.writes.map((write) => write.command.kind)).toEqual(["ISSUE_ADD", "ISSUE_SET_STATE", "ISSUE_SET_STATE", "ISSUE_DELETE"]);
  await page.getByRole("button", { name: "Salvar alterações", exact: true }).click();
  await expect(page.getByRole("button", { name: "Salvar alterações", exact: true })).toBeDisabled();
  expect(state.writes.at(-1)).toMatchObject({ expectedVersion: 6, command: { kind: "CLASSIFY" } });
  expect(state.writes.at(-1).command).not.toHaveProperty("issues");
  await page.getByText("Histórico de alterações", { exact: true }).click();
  await expect(page.locator(".q-history")).toContainText("Pendência excluída");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("failed issue commands keep input and existing issue without claiming success", async ({ page }) => {
  const state = await interactiveQueue(page, { issues: [{ id: "original", description: "Conferir origem", resolved: false }] });
  state.fail(true);
  await page.getByLabel("Nova pendência").fill("Guardar preenchimento");
  await page.getByRole("button", { name: "Adicionar", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Não foi possível salvar" })).toBeVisible();
  await expect(page.getByLabel("Nova pendência")).toHaveValue("Guardar preenchimento");
  await page.getByRole("checkbox", { name: "Resolver pendência: Conferir origem" }).click();
  await expect(page.getByRole("checkbox", { name: "Resolver pendência: Conferir origem" })).not.toBeChecked();
  await page.getByRole("button", { name: "Excluir pendência: Conferir origem" }).click();
  await page.getByRole("button", { name: "Confirmar exclusão", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Não foi possível salvar" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Confirmar exclusão da pendência" })).toBeVisible();
  expect(state.get().version).toBe(2); expect(state.get().issues).toHaveLength(1);
  await expect(page.getByRole("status").filter({ hasText: /Pendência (adicionada|resolvida|excluída)/ })).toHaveCount(0);
});

test("plate search accepts separators and short shared-field counters preserve client and status filters", async ({ page }) => {
  await interactiveQueue(page);
  await page.locator(".q-toolbar select").nth(0).selectOption("allog");
  await page.locator(".q-toolbar select").nth(1).selectOption("AGUARDANDO_LIBERACAO");
  for (const query of ["abc1d23", "ABC-1D23", " ABC 1D23 "]) {
    await page.getByRole("searchbox").fill(query);
    await expect(page.getByRole("heading", { name: "ABC-1D23", exact: true })).toBeVisible();
  }
  await expect(page.getByLabel("Booking", { exact: true })).toHaveAttribute("maxlength", "100");
  await expect(page.getByLabel("Amostra", { exact: true })).toHaveAttribute("maxlength", "100");
  await expect(page.getByLabel("Observação", { exact: true })).toHaveAttribute("maxlength", "300");
  await page.getByLabel("Booking", { exact: true }).fill("b".repeat(100));
  await expect(page.locator("#q-booking-count")).toHaveText("100/100 caracteres");
  await page.locator(".q-toolbar select").nth(1).selectOption("CHAMADO");
  await expect(page.getByRole("heading", { name: "ABC-1D23", exact: true })).toHaveCount(0);
});
