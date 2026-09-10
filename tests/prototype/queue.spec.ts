import { test, expect } from "@playwright/test";
const detail = (page: import("@playwright/test").Page) =>
  page.getByRole("region", { name: "Detalhes da visita" });
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Fila de check-ins" }),
  ).toBeVisible();
});
test("analyst classifies, client collaborates, sample does not release", async ({
  page,
}, info) => {
  await expect(
    detail(page).getByRole("button", { name: "Liberar para chamada" }),
  ).toBeDisabled();
  await detail(page).getByLabel("Cliente da visita").selectOption("allog");
  await detail(page).getByLabel("Booking", { exact: true }).fill("BK-TESTE");
  await detail(page).getByRole("button", { name: "Salvar alterações" }).click();
  await expect(detail(page).getByLabel("Booking", { exact: true })).toHaveValue(
    "BK-TESTE",
  );
  await expect(
    detail(page).getByRole("button", { name: "Liberar para chamada" }),
  ).toBeDisabled();
  await page.getByLabel("Visualizar como").selectOption("allog");
  await page.getByRole("button", { name: "ABC1D23", exact: true }).click();
  await expect(detail(page).getByLabel("Amostra", { exact: true })).toHaveValue(
    "OK",
  );
  await expect(
    page.getByText("Pendências internas", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Localização do check-in" }),
  ).toHaveCount(0);
  await detail(page)
    .getByLabel("Observação", { exact: true })
    .fill("Atualizado pelo cliente");
  await detail(page).getByRole("button", { name: "Salvar alterações" }).click();
  await expect(
    detail(page).getByLabel("Observação", { exact: true }),
  ).toHaveValue("Atualizado pelo cliente");
  await page.screenshot({
    path: `outputs/checkin-prototype-${info.project.name}-cliente.png`,
    fullPage: true,
  });
  await page.getByLabel("Visualizar como").selectOption("line");
  await detail(page).getByRole("checkbox").check();
  await detail(page).getByRole("button", { name: "Salvar alterações" }).click();
  await detail(page)
    .getByRole("button", { name: "Liberar para chamada" })
    .click();
  await expect(
    detail(page).getByRole("button", { name: "Chamar motorista" }),
  ).toBeEnabled();
  await page.screenshot({
    path: `outputs/checkin-prototype-${info.project.name}-analista.png`,
    fullPage: true,
  });
  await detail(page).getByRole("button", { name: "Chamar motorista" }).click();
  await expect(
    detail(page).getByText("Chamado", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
test("client isolation, no access, sampleless client and closed read-only", async ({
  page,
}) => {
  await page.getByLabel("Visualizar como").selectOption("allog");
  await expect(
    page.getByRole("button", { name: "JKL1M23", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Histórico", exact: true }).click();
  await expect(
    detail(page).getByLabel("Booking", { exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Visualizar como").selectOption("cliente-demo");
  await expect(detail(page).getByLabel("Amostra", { exact: true })).toHaveCount(
    0,
  );
  await page.getByLabel("Visualizar como").selectOption("sem-acesso");
  await expect(
    page.getByRole("heading", { name: "Acesso não habilitado" }),
  ).toBeVisible();
});
test("conflict retains draft and export failure leaves queue working", async ({
  page,
}) => {
  await detail(page)
    .getByLabel("Booking", { exact: true })
    .fill("MEU RASCUNHO");
  await page
    .getByText("Experimentar situações do fluxo", { exact: true })
    .click();
  await page
    .getByRole("button", { name: "Simular alteração por outra pessoa" })
    .click();
  await detail(page).getByRole("button", { name: "Salvar alterações" }).click();
  await expect(detail(page).getByRole("alert")).toContainText("Outra pessoa");
  await expect(detail(page).getByLabel("Booking", { exact: true })).toHaveValue(
    "MEU RASCUNHO",
  );
  await page.getByLabel("Simular falha na exportação").check();
  await page.getByRole("button", { name: "Exportar CSV" }).click();
  await expect(
    page.getByText("Exportação indisponível nesta simulação", { exact: false }),
  ).toBeVisible();
  await expect(detail(page)).toBeVisible();
});
test("only successful event save moves to unloading", async ({ page }) => {
  await page.getByRole("button", { name: "Chamadas", exact: true }).click();
  await page
    .getByText("Experimentar situações do fluxo", { exact: true })
    .click();
  await page.getByLabel("Simular falha ao salvar").check();
  await page
    .getByRole("button", { name: "Salvar lançamento simulado" })
    .click();
  await expect(
    detail(page).getByText("Chamado", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Simular falha ao salvar").uncheck();
  await page
    .getByRole("button", { name: "Salvar lançamento simulado" })
    .click();
  await page.getByRole("button", { name: "Todas ativas", exact: true }).click();
  await page.getByRole("button", { name: /DEMO-03/ }).click();
  await expect(
    detail(page).getByText("Em descarga", { exact: true }),
  ).toBeVisible();
});
