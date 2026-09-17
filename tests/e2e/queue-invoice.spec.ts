import { expect, test, type Page } from "@playwright/test";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import type { QueueVisit } from "../../src/lib/domain/queue";

const app = initializeApp({ projectId: "demo-transbordo-e2e" }, "queue-invoice-e2e");
const auth = getAuth(app);
const email = "invoice.e2e@example.test";
const password = "local-emulator-only";
let uid = "";
const client = { id: "allog", name: "ALLOG", portalEnabled: true, usesSample: true };
const initial: QueueVisit = {
  id: "invoice-demo", publicCode: "DEMO-NF-01", plate: "ABC1D23",
  driverName: "Motorista demonstração", carrierName: "Transportadora Demo", product: "Glicerina",
  originPlant: "Usina Demo", originInvoiceNumbers: "DEMO-NF-1", remittanceInvoiceNumber: "DEMO-NF-2",
  vehicleType: "Bitrem", clientId: "allog", clientName: "ALLOG", status: "AGUARDANDO_LIBERACAO",
  version: 2, booking: "BK-DEMO", sample: "", observation: "", usesSample: true,
  confirmedAtIso: "2026-09-10T12:00:00.000Z", updatedAtIso: "2026-09-10T12:00:00.000Z", updatedBy: "Line",
  issues: [], revisions: [], document: { status: "pending", sessionId: "driver-session", current: null },
};
const uploadUrl = "https://storage.googleapis.com/upload/storage/v1/b/demo-invoices/o?upload_id=demo-session";
const filename = "IMG_20260916_123456789_documento_demonstracao.jpg";
const photo = { name: filename, mimeType: "image/jpeg", buffer: Buffer.from([255, 216, 255, 0, 1, 2, 3, 4, 255, 217]) };
const cors = { "access-control-allow-origin": "*", "access-control-expose-headers": "Range", "access-control-allow-methods": "PUT, OPTIONS", "access-control-allow-headers": "Content-Type, Content-Range" };
const json = (data: unknown, status = 200) => ({
  status, contentType: "application/json", body: JSON.stringify(status === 200
    ? { ok: true, data }
    : { ok: false, error: { code: status === 409 ? "CONFLICT" : "VALIDATION_ERROR", message: data } }),
});
const complete = (visit: QueueVisit): QueueVisit => ({
  ...visit, version: visit.version + 1, updatedBy: "Analista Demo", updatedAtIso: "2026-09-16T15:00:00.000Z",
  document: { status: "received", sessionId: "internal-session", current: {
    id: "document-demo", object: "private/demo/original", generation: "1", name: filename,
    size: photo.buffer.length, contentType: "image/jpeg", sha256: "demo-hash",
    receivedAtIso: "2026-09-16T15:00:00.000Z", previewStatus: "pending",
  } },
  revisions: [{ id: "invoice-attached", action: "Nota fiscal anexada", actor: "Analista Demo", at: "2026-09-16T15:00:00.000Z", fields: [filename] }],
});
async function setup(page: Page, role = "ANALYST", startingVisit = initial) {
  let visit = structuredClone(startingVisit);
  const writes: any[] = [];
  const base = role === "CUSTOMER" ? "/api/customer/checkins" : "/api/checkins";
  const profile = { uid, email, name: "Analista Demo", role, clientId: role === "CUSTOMER" ? "allog" : null, approved: true, active: true };
  await page.route("**/api/me", (route) => route.fulfill(json({ profile, checkinsEnabled: true, approvalContactPhone: null })));
  await page.route("**/api/auth/sync", (route) => route.fulfill(json({ profile })));
  await page.route(`**${base}`, (route) => route.fulfill(json({ items: [{ ...visit, revisions: undefined }], clients: [client], nextCursor: null })));
  await page.route(`**${base}/invoice-demo`, (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON(); writes.push(body);
      if (body.expectedVersion !== visit.version)
        return route.fulfill(json("Outra pessoa alterou esta visita. Seu preenchimento foi mantido.", 409));
      visit = { ...visit, ...body.command.shared, version: visit.version + 1 };
    }
    return route.fulfill(json({ item: visit }));
  });
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Senha").fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  if (role === "ADMIN" || role === "SUPERVISOR") {
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.goto("/checkins");
  }
  await expect(page).toHaveURL(role === "CUSTOMER" ? /\/customer\/checkins$/ : /\/checkins$/);
  await expect(page.getByRole("heading", { name: role === "CUSTOMER" ? "Minhas cargas" : "Fila de check-ins", exact: true })).toBeVisible();
  return { writes, get: () => visit, set: (next: QueueVisit) => { visit = next; } };
}
async function choose(page: Page, file = photo) {
  await page.getByLabel("Arquivo da nota fiscal").setInputFiles(file);
}

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  const old = await auth.getUserByEmail(email).catch(() => null);
  if (old) await auth.deleteUser(old.uid);
  uid = (await auth.createUser({ email, password, emailVerified: true })).uid;
});
test.afterAll(async () => { if (uid) await auth.deleteUser(uid); await deleteApp(app); });

test("a photo resumes after interruption and preserves the draft, history and separate release", async ({ page }) => {
  const state = await setup(page);
  const documents: any[] = [];
  const uploads: { range: string; body: Buffer | null; authorization?: string; type?: string }[] = [];
  let acknowledged = 0;
  await page.route("https://storage.googleapis.com/**", (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const headers = route.request().headers();
    const range = headers["content-range"];
    uploads.push({ range, body: route.request().postDataBuffer(), authorization: headers.authorization, type: headers["content-type"] });
    if (range.startsWith("bytes */")) return route.fulfill({ status: 308, headers: { ...cors, ...(acknowledged ? { Range: "bytes=0-4" } : {}) } });
    if (!acknowledged) { acknowledged = 5; return route.abort("connectionreset"); }
    return route.fulfill({ status: 200, headers: cors });
  });
  await page.route("**/api/checkins/invoice-demo/document", (route) => {
    const body = route.request().postDataJSON(); documents.push(body);
    if (body.action === "begin") return route.fulfill(json({ sessionId: "internal-session", uploadUrl, received: false }));
    state.set(complete(state.get()));
    return route.fulfill(json({ sessionId: "internal-session", received: true, item: state.get() }));
  });
  await expect(page.getByRole("button", { name: "Liberar para chamada", exact: true })).toBeDisabled();
  await page.getByLabel("Booking", { exact: true }).fill("RASCUNHO-PRESERVADO");
  await choose(page, { ...photo, mimeType: "" });
  await expect(page.getByText("Foto da nota", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Enviar nota", exact: true }).click();
  await expect(page.getByText("Nota recebida e vinculada à visita.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Booking", { exact: true })).toHaveValue("RASCUNHO-PRESERVADO");
  await page.getByText("Histórico de alterações", { exact: true }).click();
  await expect(page.locator(".q-history")).toContainText("Nota fiscal anexada");
  await expect(page.locator(".q-history")).toContainText("Analista Demo");
  await expect(page.locator(".q-history article")).toHaveCount(1);
  expect(documents.map((body) => body.action)).toEqual(["begin", "finalize"]);
  expect(documents[0]).toMatchObject({ expectedVersion: 2, name: filename, size: photo.buffer.length });
  expect(uploads.map((upload) => upload.range)).toEqual(["bytes */10", "bytes 0-9/10", "bytes */10", "bytes 5-9/10"]);
  expect(uploads.at(-1)?.body).toEqual(photo.buffer.subarray(5));
  expect(uploads.every((upload) => !upload.authorization && upload.type === "application/octet-stream")).toBe(true);
  await expect(page.getByRole("button", { name: "Liberar para chamada", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Salvar alterações", exact: true }).click();
  await expect(page.getByRole("button", { name: "Salvar alterações", exact: true })).toBeDisabled();
  expect(state.writes[0].expectedVersion).toBe(3);
  await expect(page.getByRole("button", { name: "Liberar para chamada", exact: true })).toBeEnabled();
  expect(state.get().status).toBe("AGUARDANDO_LIBERACAO");
  await page.getByRole("button", { name: "Atualizar", exact: true }).click();
  await expect(page.locator(".q-history article")).toHaveCount(1);
  await page.reload();
  await expect(page.getByRole("button", { name: "Baixar original", exact: true })).toBeVisible();
  await page.getByText("Histórico de alterações", { exact: true }).click();
  await expect(page.locator(".q-history article")).toHaveCount(1);
});

test("lost finalize response retries the same receipt without a second upload or event", async ({ page }) => {
  const state = await setup(page);
  let begins = 0, finalizes = 0, puts = 0;
  await page.route("https://storage.googleapis.com/**", (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    puts++;
    return route.fulfill({ status: route.request().headers()["content-range"].startsWith("bytes */") ? 308 : 200, headers: cors });
  });
  await page.route("**/api/checkins/invoice-demo/document", (route) => {
    const body = route.request().postDataJSON();
    if (body.action === "begin") { begins++; return route.fulfill(json({ sessionId: "internal-session", uploadUrl, received: false })); }
    expect(body.sessionId).toBe("internal-session");
    finalizes++;
    if (finalizes === 1) { state.set(complete(state.get())); return route.abort("failed"); }
    return route.fulfill(json({ sessionId: "internal-session", received: true, item: state.get() }));
  });
  await choose(page);
  await page.getByRole("button", { name: "Enviar nota", exact: true }).click();
  await expect(page.getByRole("button", { name: "Tentar novamente", exact: true })).toBeVisible();
  await expect(page.getByText("Foto da nota", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Tentar novamente", exact: true }).click();
  await expect(page.getByText("Nota recebida e vinculada à visita.", { exact: false })).toBeVisible();
  expect({ begins, finalizes, puts }).toEqual({ begins: 1, finalizes: 2, puts: 2 });
  expect(state.get().version).toBe(3);
});

test("technical validation and an API conflict keep the file and form without a silent overwrite", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  const operations: any[] = [];
  await page.route("**/api/checkins/invoice-demo/document", (route) => {
    operations.push(route.request().postDataJSON());
    return route.fulfill(json("Outra pessoa alterou esta visita. Atualize a fila antes de enviar a nota.", 409));
  });
  await page.getByLabel("Booking", { exact: true }).fill("MANTER-RASCUNHO");
  await choose(page);
  await choose(page, { name: "muito-grande.jpg", mimeType: "image/jpeg", buffer: Buffer.alloc(10_000_001) });
  await expect(page.getByRole("alert").filter({ hasText: "até 10 MB" })).toBeVisible();
  await expect(page.locator(".q-invoice-filename")).toHaveText(filename);
  await choose(page, { name: "arquivo.exe", mimeType: "application/octet-stream", buffer: Buffer.from("invalid") });
  await expect(page.getByRole("alert").filter({ hasText: "JPEG" })).toBeVisible();
  expect(operations).toHaveLength(0);
  await page.getByRole("button", { name: "Enviar nota", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Outra pessoa" })).toBeVisible();
  await page.getByRole("button", { name: "Tentar novamente", exact: true }).click();
  await expect.poll(() => operations.length).toBe(2);
  expect(operations[0].operationId).toBe(operations[1].operationId);
  await expect(page.getByLabel("Booking", { exact: true })).toHaveValue("MANTER-RASCUNHO");
  await expect(page.locator(".q-invoice-filename")).toHaveText(filename);
  await expect(page.getByRole("button", { name: "Liberar para chamada", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("a concurrent classification returned with the receipt never silently rebases a draft", async ({ page }) => {
  const state = await setup(page);
  await page.route("https://storage.googleapis.com/**", (route) => route.fulfill({ status: route.request().method() === "OPTIONS" ? 204 : route.request().headers()["content-range"].startsWith("bytes */") ? 308 : 200, headers: cors }));
  await page.route("**/api/checkins/invoice-demo/document", (route) => {
    if (route.request().postDataJSON().action === "begin") return route.fulfill(json({ sessionId: "internal-session", uploadUrl, received: false }));
    state.set({ ...complete(state.get()), version: 4, booking: "ALTERADO-POR-OUTRA-PESSOA" });
    return route.fulfill(json({ sessionId: "internal-session", received: true, item: state.get() }));
  });
  await page.getByLabel("Booking", { exact: true }).fill("MEU-RASCUNHO");
  await choose(page);
  await page.getByRole("button", { name: "Enviar nota", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Outra pessoa alterou os dados" })).toBeVisible();
  await expect(page.getByLabel("Booking", { exact: true })).toHaveValue("MEU-RASCUNHO");
  await page.getByRole("button", { name: "Salvar alterações", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0].expectedVersion).toBe(2);
  await expect(page.getByLabel("Booking", { exact: true })).toHaveValue("MEU-RASCUNHO");
  expect(state.get().booking).toBe("ALTERADO-POR-OUTRA-PESSOA");
  await page.getByRole("button", { name: "Descartar rascunho e usar dados atuais" }).click();
  await expect(page.getByLabel("Booking", { exact: true })).toHaveValue("ALTERADO-POR-OUTRA-PESSOA");
});

for (const role of ["ADMIN", "SUPERVISOR", "CUSTOMER"]) test(`${role} sees only its allowed invoice controls`, async ({ page }) => {
  await setup(page, role);
  const button = page.getByRole("button", { name: "Anexar foto ou PDF", exact: true });
  if (role === "CUSTOMER") {
    await expect(button).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Nota fiscal", exact: true })).toHaveCount(0);
    await expect(page.getByText("Histórico de alterações", { exact: true })).toHaveCount(0);
  } else {
    await expect(button).toBeVisible();
    await choose(page);
    await page.getByRole("button", { name: "Cancelar seleção", exact: true }).click();
    await expect(page.getByText("Foto da nota", { exact: true })).toHaveCount(0);
  }
  await expect(page.getByRole("button", { name: /Substituir|Excluir arquivo/ })).toHaveCount(0);
});


const replacementPdf = { name: "nota-corrigida.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\nDocumento ficticio\n%%EOF") };
function replace(visit: QueueVisit): QueueVisit {
  return {
    ...visit, version: visit.version + 1, updatedBy: "Analista Demo", updatedAtIso: "2026-09-17T16:00:00.000Z",
    document: { status: "received", sessionId: "replacement-session", current: {
      id: "replacement-document", object: "private/demo/replacement", generation: "2", name: replacementPdf.name,
      size: replacementPdf.buffer.length, contentType: "application/pdf", sha256: "replacement-hash",
      receivedAtIso: "2026-09-17T16:00:00.000Z", previewStatus: "not-applicable",
    } },
    revisions: [{ id: "invoice-replaced", action: "Nota fiscal substituída", actor: "Analista Demo", at: "2026-09-17T16:00:00.000Z", fields: [replacementPdf.name] }, ...(visit.revisions ?? [])],
  };
}
const oldVersion = {
  id: "document-demo", name: filename, size: photo.buffer.length, contentType: "image/jpeg",
  replacedAtIso: "2026-09-17T16:00:00.000Z", expiresAtIso: "2026-12-16T16:00:00.000Z",
  replacedBy: "Analista Demo", state: "available", available: true,
};
async function mockStorage(page: Page) {
  await page.route("https://storage.googleapis.com/**", (route) => route.fulfill({
    status: route.request().method() === "OPTIONS" ? 204 : route.request().headers()["content-range"].startsWith("bytes */") ? 308 : 200,
    headers: cors,
  }));
}

test("replacement confirms explicitly, preserves draft and original on cancel, and shows persisted version history", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const received = complete(initial);
  received.document!.current!.previewStatus = "ready";
  const state = await setup(page, "ANALYST", received);
  const documents: any[] = [];
  const historyRequests: string[] = [];
  const versionDownloads: string[] = [];
  await mockStorage(page);
  await page.route("**/api/checkins/invoice-demo/document**", (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "GET") {
      if (url.searchParams.has("history")) {
        historyRequests.push(url.searchParams.get("cursor") ?? "first");
        return route.fulfill(json(url.searchParams.has("cursor")
          ? { items: [{ ...oldVersion, id: "expired-document", name: "nota-antiga.pdf", contentType: "application/pdf", available: false, state: "deleted" }], nextCursor: null }
          : { items: [oldVersion], nextCursor: "opaque-next-page" }));
      }
      if (url.searchParams.has("version")) versionDownloads.push(url.searchParams.get("version")!);
      return route.fulfill(json({ url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4iUAAAAASUVORK5CYII=", name: filename }));
    }
    const body = route.request().postDataJSON(); documents.push(body);
    if (body.action === "begin") return route.fulfill(json({ sessionId: "replacement-session", uploadUrl, received: false }));
    state.set(replace(state.get()));
    return route.fulfill(json({ sessionId: "replacement-session", received: true, item: state.get() }));
  });
  await expect(page.getByRole("button", { name: "Substituir documento", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Visualizar nota", exact: true }).click();
  await expect(page.getByRole("img", { name: "Prévia da nota fiscal desta visita" })).toBeVisible();
  await page.getByLabel("Booking", { exact: true }).fill("RASCUNHO-DA-TROCA");
  await choose(page, replacementPdf);
  await expect(page.getByText("A versão anterior ficará no histórico por 90 dias após a troca.", { exact: false })).toBeVisible();
  expect(documents).toHaveLength(0);
  await page.getByRole("button", { name: "Cancelar seleção", exact: true }).click();
  await expect(page.getByRole("button", { name: "Substituir nota", exact: true })).toHaveCount(0);
  await expect(page.locator(".q-invoice > .q-invoice-file")).toContainText(filename);
  await expect(page.getByLabel("Booking", { exact: true })).toHaveValue("RASCUNHO-DA-TROCA");
  expect(documents).toHaveLength(0);
  await choose(page, replacementPdf);
  await page.getByRole("button", { name: "Substituir nota", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Nota substituída" })).toBeVisible();
  await expect(page.locator(".q-invoice > .q-invoice-file")).toContainText(replacementPdf.name);
  await expect(page.getByRole("img", { name: "Prévia da nota fiscal desta visita" })).toHaveCount(0);
  await expect(page.getByLabel("Booking", { exact: true })).toHaveValue("RASCUNHO-DA-TROCA");
  expect(documents[0]).toMatchObject({ action: "begin", expectedVersion: 3, replaceDocumentId: "document-demo", name: replacementPdf.name });
  expect(documents.map((body) => body.action)).toEqual(["begin", "finalize"]);
  expect(state.get().status).toBe("AGUARDANDO_LIBERACAO");
  expect(historyRequests).toHaveLength(0);
  await page.getByText("Histórico dos documentos", { exact: true }).click();
  await expect(page.locator(".q-invoice-history li")).toHaveCount(1);
  await expect(page.locator(".q-invoice-history li")).toContainText("Analista Demo");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Baixar versão anterior", exact: true }).click();
  await download;
  expect(versionDownloads).toEqual(["document-demo"]);
  await page.getByRole("button", { name: "Carregar mais documentos", exact: true }).click();
  await expect(page.locator(".q-invoice-history li")).toHaveCount(2);
  await expect(page.locator(".q-invoice-history li").last()).toContainText("Arquivo indisponível");
  await expect(page.locator(".q-invoice-history li").last().getByRole("button")).toHaveCount(0);
  expect(historyRequests).toEqual(["first", "opaque-next-page"]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.reload();
  await expect(page.locator(".q-invoice > .q-invoice-file")).toContainText(replacementPdf.name);
  await page.getByText("Histórico dos documentos", { exact: true }).click();
  await expect(page.locator(".q-invoice-history li")).toContainText(filename);
  await page.getByText("Histórico de alterações", { exact: true }).click();
  await expect(page.locator(".q-history article")).toHaveCount(2);
  await expect(page.locator(".q-history")).toContainText("Nota fiscal substituída");
});

test("lost replacement confirmation retries the same operation while keeping the old document visible", async ({ page }) => {
  const state = await setup(page, "ANALYST", complete(initial));
  let begins = 0, finalizes = 0;
  await mockStorage(page);
  await page.route("**/api/checkins/invoice-demo/document", (route) => {
    const body = route.request().postDataJSON();
    if (body.action === "begin") {
      begins++; expect(body.replaceDocumentId).toBe("document-demo");
      return route.fulfill(json({ sessionId: "replacement-session", uploadUrl, received: false }));
    }
    expect(body.sessionId).toBe("replacement-session"); finalizes++;
    if (finalizes === 1) { state.set(replace(state.get())); return route.abort("failed"); }
    return route.fulfill(json({ sessionId: "replacement-session", received: true, item: state.get() }));
  });
  await choose(page, replacementPdf);
  await page.getByRole("button", { name: "Substituir nota", exact: true }).click();
  await expect(page.getByRole("button", { name: "Tentar novamente", exact: true })).toBeVisible();
  await expect(page.locator(".q-invoice > .q-invoice-file")).toContainText(filename);
  await expect(page.locator(".q-invoice-selection")).toContainText(replacementPdf.name);
  await page.getByRole("button", { name: "Tentar novamente", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Nota substituída" })).toBeVisible();
  expect({ begins, finalizes }).toEqual({ begins: 1, finalizes: 2 });
  expect(state.get().version).toBe(4);
  expect(state.get().revisions).toHaveLength(2);
});

test("replacement retries never change their selected target or version after an expired session and concurrent refresh", async ({ page }) => {
  const state = await setup(page, "ANALYST", complete(initial));
  const operations: any[] = [];
  await page.route("**/api/checkins/invoice-demo/document", (route) => {
    operations.push(route.request().postDataJSON());
    return route.fulfill(json(operations.length === 1 ? "A sessão expirou. Tente novamente." : "A nota foi substituída por outra pessoa. Confira o documento atual.", operations.length === 1 ? 410 : 409));
  });
  await page.getByLabel("Booking", { exact: true }).fill("RASCUNHO-CONCORRENTE");
  await choose(page, replacementPdf);
  await page.getByRole("button", { name: "Substituir nota", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "expirou" })).toBeVisible();
  state.set(replace(state.get()));
  await page.getByRole("button", { name: "Atualizar", exact: true }).click();
  await expect(page.locator(".q-invoice > .q-invoice-file")).toContainText(replacementPdf.name);
  await page.getByRole("button", { name: "Tentar novamente", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "substituída por outra pessoa" })).toBeVisible();
  expect(operations).toHaveLength(2);
  for (const body of operations) expect(body).toMatchObject({ expectedVersion: 3, replaceDocumentId: "document-demo" });
  await expect(page.getByLabel("Booking", { exact: true })).toHaveValue("RASCUNHO-CONCORRENTE");
  await expect(page.locator(".q-invoice-target")).toHaveText(filename);
});

test("history errors retry without losing records and expired downloads become unavailable", async ({ page }) => {
  await setup(page, "SUPERVISOR", complete(initial));
  let loads = 0;
  await page.route("**/api/checkins/invoice-demo/document?*", (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("version")) return route.fulfill(json("O prazo desta versão encerrou. Registro preservado.", 410));
    loads++;
    if (loads === 1) return route.fulfill(json("Não foi possível consultar as versões agora.", 503));
    return route.fulfill(json({ items: [oldVersion], nextCursor: null }));
  });
  await expect(page.getByRole("button", { name: "Substituir documento", exact: true })).toBeVisible();
  await page.getByText("Histórico dos documentos", { exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "consultar as versões" })).toBeVisible();
  await page.getByRole("button", { name: "Tentar carregar histórico novamente" }).click();
  await expect(page.locator(".q-invoice-history li")).toHaveCount(1);
  await page.getByRole("button", { name: "Baixar versão anterior", exact: true }).click();
  await expect(page.locator(".q-invoice-history li")).toContainText("Arquivo indisponível");
  await expect(page.getByRole("button", { name: "Baixar versão anterior", exact: true })).toHaveCount(0);
  await expect(page.locator(".q-invoice > .q-invoice-file")).toContainText(filename);
});
