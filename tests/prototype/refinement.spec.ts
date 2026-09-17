import { test, expect } from '@playwright/test';
const detail = (page: import('@playwright/test').Page) => page.getByRole('region', {name: 'Detalhes da visita'});
test.beforeEach(async ({page}) => { await page.goto('/'); });
test('pending saves independently and survives reselection without classifying draft', async ({page}) => {
 const d = detail(page);
 await d.getByLabel('Cliente da visita').selectOption('allog');
 await d.getByLabel('Booking', {exact:true}).fill('RASCUNHO');
 await d.getByLabel('Nova pendência').fill('Confirmar remessa com a usina');
 await d.getByRole('button',{name:'Adicionar',exact:true}).click();
 await expect(d.getByLabel('Booking',{exact:true})).toHaveValue('RASCUNHO');
 await expect(d.getByLabel('Cliente da visita')).toHaveValue('allog');
 await expect(d.getByText('Confirmar remessa com a usina',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:/DEMO-02/}).click();
 await page.getByRole('button',{name:/DEMO-01/}).click();
 await expect(d.getByLabel('Booking',{exact:true})).toHaveValue('');
 await expect(d.getByLabel('Cliente da visita')).toHaveValue('');
 const issue = d.locator('.q-issue').filter({hasText:'Confirmar remessa com a usina'});
 await issue.getByRole('checkbox').check();
 await expect(issue.getByText('Resolvida',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:/DEMO-02/}).click();
 await page.getByRole('button',{name:/DEMO-01/}).click();
 await expect(issue.getByRole('checkbox')).toBeChecked();
});
test('limits, empty recovery and trip disclosure work', async ({page}) => {
 const d = detail(page);
 await expect(d.getByLabel('Booking',{exact:true})).toHaveAttribute('maxlength','100');
 await expect(d.getByLabel('Amostra',{exact:true})).toHaveAttribute('maxlength','100');
 await expect(d.getByLabel('Observação',{exact:true})).toHaveAttribute('maxlength','300');
 await d.getByLabel('Booking',{exact:true}).fill('a'.repeat(130));
 expect((await d.getByLabel('Booking',{exact:true}).inputValue()).length).toBe(100);
 await page.getByRole('searchbox').fill('NÃO EXISTE');
 await expect(page.getByRole('heading',{name:'Nenhuma visita nesta seleção'})).toBeVisible();
 await page.getByRole('button',{name:'Ver cargas em andamento'}).click();
 await expect(d).toBeVisible();
 await d.locator('summary').filter({hasText:'Dados da viagem'}).click();
 await expect(d.getByRole('button',{name:'Localização do check-in'})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('footer remains reachable and keyboard focus returns from note analysis', async ({page}, info) => {
 const d = detail(page);
 if(info.project.name==='desktop') {
  const box=await d.getByRole('button',{name:'Salvar alterações'}).boundingBox();
  expect(box!.y+box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
 }
 const analyze=page.getByRole('button',{name:'Analisar nota'});
 await analyze.click();
 await page.keyboard.press('Escape');
 await expect(page.getByRole('dialog')).toHaveCount(0);
 await expect(analyze).toBeFocused();
});
