import {test, expect} from '@playwright/test';
const detail=(page:import('@playwright/test').Page)=>page.getByRole('region',{name:'Detalhes da visita'});
const invoice=(page:import('@playwright/test').Page)=>page.getByRole('region',{name:'Nota fiscal da visita'});
test.beforeEach(async({page})=>{await page.goto('/');});
test('invoice is inline, analysis preserves draft and original download works',async({page})=>{
 const errors:string[]=[];const requests:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().startsWith('http'))requests.push(r.url())});
 await detail(page).getByLabel('Booking',{exact:true}).fill('RASCUNHO-NF');
 await invoice(page).getByText('Visualizar nota',{exact:true}).click();await expect(invoice(page).getByRole('img')).toBeVisible();
 await invoice(page).getByRole('button',{name:'Analisar nota'}).click();const dialog=page.getByRole('dialog',{name:'Análise da nota fiscal'});await expect(dialog).toContainText('DEMO-01 · ABC1D23');
 await dialog.getByRole('button',{name:'Ver original',exact:true}).click();await expect(dialog.getByText('Arquivo original de demonstração.',{exact:true})).toBeVisible();
 const download=page.waitForEvent('download');await dialog.getByRole('link',{name:'Baixar original',exact:true}).click();expect((await download).suggestedFilename()).toBe('nota-demo-ABC1D23.png');
 await dialog.getByRole('button',{name:'Voltar à fila'}).click();await expect(dialog).toHaveCount(0);await expect(detail(page).getByLabel('Booking',{exact:true})).toHaveValue('RASCUNHO-NF');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);expect(requests).toEqual([]);
});
test('failed replacement retains original; successful PDF has history and does not release',async({page})=>{
 await invoice(page).getByRole('button',{name:'Substituir documento'}).click();await invoice(page).getByLabel('Arquivo de demonstração').selectOption('pdf');await invoice(page).getByLabel('Simular falha no envio do documento').check();await invoice(page).getByRole('button',{name:'Simular envio',exact:true}).click();await expect(invoice(page)).toContainText('Falha simulada');await expect(invoice(page)).toContainText('nota-demo-ABC1D23.png');
 await invoice(page).getByLabel('Simular falha no envio do documento').uncheck();await invoice(page).getByRole('button',{name:'Simular envio',exact:true}).click();await expect(invoice(page)).toContainText('nota-demo-ABC1D23.pdf');await expect(detail(page).getByRole('button',{name:'Liberar para chamada'})).toBeDisabled();
 await invoice(page).getByRole('button',{name:'Analisar nota'}).click();const dialog=page.getByRole('dialog');await expect(dialog.getByRole('button',{name:/Anterior.*png/})).toBeVisible();await dialog.getByRole('button',{name:'Ver original',exact:true}).click();await expect(dialog.locator('iframe')).toHaveAttribute('src',/^data:application\/pdf;base64,/);const src=await dialog.locator('iframe').getAttribute('src');expect(Buffer.from(src!.split(',')[1],'base64').toString()).toContain('%PDF-1.4');
 await dialog.getByRole('button',{name:/Anterior.*png/}).click();await expect(dialog).toContainText('Disponível até');await expect(dialog.getByRole('link',{name:'Baixar original'})).toHaveAttribute('download','nota-demo-ABC1D23.png');
 await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);
});
test('missing document blocks release even after other pending issues are resolved',async({page})=>{
 await page.getByRole('button',{name:/DEMO-04/}).click();await expect(invoice(page)).toContainText('Documento pendente');await detail(page).getByRole('checkbox').check();await expect(detail(page).getByRole('button',{name:'Liberar para chamada'})).toBeDisabled();
 await invoice(page).getByRole('button',{name:'Anexar foto ou PDF'}).click();await invoice(page).getByRole('button',{name:'Simular envio',exact:true}).click();await expect(detail(page).getByRole('button',{name:'Liberar para chamada'})).toBeEnabled();await expect(detail(page).getByText('Aguardando liberação',{exact:true})).toBeVisible();
 await detail(page).getByRole('button',{name:'Liberar para chamada'}).click();await expect(detail(page).getByRole('button',{name:'Chamar motorista'})).toBeEnabled();
});
test('customer cannot see invoices; admin deletion keeps textual history and reset restores fixture',async({page})=>{
 await expect(invoice(page).getByRole('button',{name:'Excluir arquivo…'})).toHaveCount(0);await page.getByLabel('Visualizar como').selectOption('allog');await expect(invoice(page)).toHaveCount(0);await expect(page.getByRole('button',{name:'Analisar nota'})).toHaveCount(0);
 await page.getByLabel('Visualizar como').selectOption('admin');await invoice(page).getByRole('button',{name:'Excluir arquivo…'}).click();await expect(invoice(page)).toContainText('DEMO-01, placa ABC1D23');await invoice(page).getByRole('button',{name:'Cancelar exclusão'}).click();await expect(invoice(page)).toContainText('Documento recebido');await invoice(page).getByRole('button',{name:'Excluir arquivo…'}).click();await invoice(page).getByRole('button',{name:'Confirmar exclusão'}).click();await expect(invoice(page)).toContainText('Documento pendente');await invoice(page).getByRole('button',{name:'Histórico dos documentos'}).click();await expect(page.getByRole('dialog')).toContainText('Registro textual preservado');await page.getByRole('button',{name:'Voltar à fila'}).click();
 await page.getByText('Experimentar situações do fluxo',{exact:true}).click();await page.getByRole('button',{name:'Reiniciar demonstração'}).click();await expect(invoice(page)).toContainText('Documento recebido');
});
