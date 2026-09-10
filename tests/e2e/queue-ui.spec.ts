import { expect, test } from "@playwright/test";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
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
