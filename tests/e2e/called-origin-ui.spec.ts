import {expect,test,type Page} from "@playwright/test";
import {initializeApp,deleteApp} from "firebase-admin/app";
import {getAuth} from "firebase-admin/auth";
const app=initializeApp({projectId:"demo-transbordo-e2e"},"called-origin-ui");
const auth=getAuth(app),email="called.origin.e2e@example.test",password="local-emulator-only";
let uid="";
const json=(data:unknown,status=200)=>({status,contentType:"application/json",body:JSON.stringify(status===200?{ok:true,data}:{ok:false,error:{code:"CONFLICT",message:data}})});
async function setup(page:Page,mode:"off"|"observe"|"enforce"="observe") {
  const profile={email,name:"Operação teste",role:"ADMIN",active:true,approved:true};
  const submitted:Record<string,unknown>[]=[];let calledQueries=0;
  await page.route("**/api/me",r=>r.fulfill(json({profile,checkinsEnabled:mode!=="off",containerTransfersEnabled:true,approvalContactPhone:null})));
  await page.route("**/api/auth/sync",r=>r.fulfill(json({profile})));
  await page.route("**/api/clients*",r=>r.fulfill(json({items:[{id:"allog",name:"ALLOG",active:true},{id:"other",name:"Outro cliente",active:true}]})));
  await page.route("**/api/events?*",r=>r.fulfill(json({items:[],nextCursor:null,incomplete:false})));
  await page.route("**/api/events/gap-preview",r=>r.fulfill(json({toleranceMinutes:10,gapVersion:"gap-current",uncoveredSegments:[],uncoveredMinutes:0,requiresJustification:false,reconciliations:[]})));
  await page.route("**/api/events",r=>{submitted.push(r.request().postDataJSON());return r.fulfill(json("Falha de teste ao salvar. Os dados foram preservados.",409));});
  await page.route("**/api/containers/lookup?*",r=>r.fulfill(json({current:null,availableStatuses:["FULL","PARTIAL","BUFFER"],requiresNewCycleConfirmation:false})));
  await page.route("**/api/containers?*",r=>r.fulfill(json({items:[{container:"TSTU 250001-9",status:"BUFFER",clientId:"allog",clientNameSnapshot:"ALLOG",version:7,cycleId:"source-cycle"}],nextCursor:null,incomplete:false})));
  await page.route("**/api/checkins/called",r=>{calledQueries++;return r.fulfill(json({enabled:mode!=="off",mode,items:mode==="off"?[]:[{id:"visit-called",publicCode:"LT-DEMO1234",plate:"ABC1D23",clientId:"allog",clientName:"ALLOG",version:7}]}));});
  await page.goto("/login");await page.getByLabel("Email").fill(email);await page.getByLabel("Senha").fill(password);await page.getByRole("button",{name:"Entrar",exact:true}).click();await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto("/events");const form=page.getByRole("heading",{name:"Novo lançamento"}).locator("..");
  await form.getByLabel("Horário início").fill("06:00");await form.getByLabel("Horário fim").fill("06:20");await form.getByLabel("Container de destino *").fill("TSTU2500024");
  return {form,submitted,queries:()=>calledQueries};
}
test.describe.configure({mode:"serial"});
test.beforeAll(async()=>{const old=await auth.getUserByEmail(email).catch(()=>null);if(old)await auth.deleteUser(old.uid);uid=(await auth.createUser({email,password,emailVerified:true})).uid;});
test.afterAll(async()=>{if(uid)await auth.deleteUser(uid);await deleteApp(app);});

test("one origin field selects the called plate and keeps the visit after a failed save",async({page})=>{
  const {form,submitted}=await setup(page,"enforce");const origin=form.getByLabel("Placa ou container de origem *");
  await expect(page.getByLabel("Visita chamada")).toHaveCount(0);
  await origin.fill("abc-1");await expect(form.getByRole("option",{name:/ABC-1D23.*ALLOG.*LT-DEMO1234/})).toBeVisible();
  await origin.press("ArrowDown");await origin.press("Enter");
  await expect(origin).toHaveValue("ABC-1D23");await expect(form.getByLabel("Cliente *")).toHaveValue("allog");
  expect(submitted).toHaveLength(0);
  await expect(form.getByText(/descarga começa somente quando o lançamento for salvo/)).toBeVisible();
  await form.getByRole("button",{name:"Salvar lançamento"}).click();
  await expect.poll(()=>submitted.length).toBe(1);
  expect(submitted[0]).toMatchObject({checkInId:"visit-called",expectedCheckinVersion:7,plate:"ABC-1D23",clientId:"allog",loadSourceType:"TRUCK"});
  await expect(page.getByText("Falha de teste ao salvar. Os dados foram preservados.",{exact:true})).toBeVisible();
  await expect(origin).toHaveValue("ABC-1D23");
});

test("changing the plate or client clears its hidden link while observe allows a manual truck",async({page})=>{
  const {form,submitted}=await setup(page);const origin=form.getByLabel("Placa ou container de origem *");
  await origin.fill("ABC");await form.getByRole("option",{name:/LT-DEMO1234/}).click();
  await origin.fill("DEF4G56");await form.getByLabel("Cliente *").selectOption("other");await form.getByRole("button",{name:"Salvar lançamento"}).click();
  await expect.poll(()=>submitted.length).toBe(1);expect(submitted[0]).not.toHaveProperty("checkInId");expect(submitted[0]).not.toHaveProperty("expectedCheckinVersion");
  expect(submitted[0]).toMatchObject({plate:"DEF4G56",clientId:"other"});
});

test("enforce requires choosing a called plate but still accepts container sources",async({page})=>{
  const {form,submitted}=await setup(page,"enforce");const origin=form.getByLabel("Placa ou container de origem *");
  await expect(form.getByRole("button",{name:"Atualizar chamadas"})).toBeEnabled();
  await origin.fill("ABC1D23");await form.getByLabel("Cliente *").selectOption("allog");
  expect(await origin.evaluate((input:HTMLInputElement)=>input.checkValidity())).toBe(false);
  await origin.fill("ABC");await form.getByRole("option",{name:/LT-DEMO1234/}).click();
  await origin.fill("TSTU");await form.getByRole("option",{name:/TSTU 250001-9/}).click();
  await form.getByLabel("Não, restará carga").check();
  await form.getByRole("button",{name:"Salvar lançamento"}).click();await expect.poll(()=>submitted.length).toBe(1);
  expect(submitted[0]).toMatchObject({loadSourceType:"BUFFER_CONTAINER",sourceContainer:"TSTU 250001-9",clientId:"allog"});
  expect(submitted[0]).not.toHaveProperty("checkInId");expect(submitted[0]).not.toHaveProperty("expectedCheckinVersion");
});

test("off mode keeps the manual origin and does not query check-ins",async({page})=>{
  const {form,submitted,queries}=await setup(page,"off");const origin=form.getByLabel("Placa ou container de origem *");
  await origin.fill("ABC1D23");await form.getByLabel("Cliente *").selectOption("allog");await form.getByRole("button",{name:"Salvar lançamento"}).click();
  await expect.poll(()=>submitted.length).toBe(1);expect(queries()).toBe(0);expect(submitted[0]).not.toHaveProperty("checkInId");
  await expect(form.getByRole("button",{name:"Atualizar chamadas"})).toHaveCount(0);
});
