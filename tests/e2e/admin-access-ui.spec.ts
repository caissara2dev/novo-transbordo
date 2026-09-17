import {expect, test, type Page} from "@playwright/test";
import {initializeApp, deleteApp} from "firebase-admin/app";
import {getAuth} from "firebase-admin/auth";

const app=initializeApp({projectId:"demo-transbordo-e2e"},"admin-access-ui");
const auth=getAuth(app);
const email="admin.access.e2e@example.test";
const password="local-emulator-only";
let uid="";
const json=(data:unknown,status=200)=>({status,contentType:"application/json",body:JSON.stringify(status===200?{ok:true,data}:{ok:false,error:{code:"CONFLICT",message:data}})});
async function setup(page:Page) {
  const profile={email,name:"Admin teste",role:"ADMIN",active:true,approved:true,accessVersion:0};
  let users=[{id:"pending",email:"pending@example.test",name:"Conta de cliente",role:"OPERATOR",active:true,approved:false,clientId:null as string|null,accessVersion:0},{...profile,id:uid,clientId:null as string|null}];
  let clients=[{id:"allog",name:"ALLOG",nameUpper:"ALLOG",active:true,portalEnabled:true,usesSample:true,accessVersion:0},{id:"disabled",name:"Sem portal",nameUpper:"SEM PORTAL",active:true,portalEnabled:false,usesSample:true,accessVersion:0}];
  const writes:Array<{path:string;body:Record<string,unknown>}>=[];
  let conflict=false;
  await page.route("**/api/me",route=>route.fulfill(json({profile,checkinsEnabled:true,approvalContactPhone:null})));
  await page.route("**/api/auth/sync",route=>route.fulfill(json({profile})));
  await page.route("**/api/users",route=>route.fulfill(json({items:users})));
  await page.route("**/api/users/*/*",route=>{
    const body=route.request().postDataJSON();const path=new URL(route.request().url()).pathname;writes.push({path,body});
    if(conflict) return route.fulfill(json("Este cadastro foi alterado por outra pessoa. Atualize a lista e confira os dados antes de salvar.",409));
    users=users.map(user=>user.id==="pending"?{...user,...(path.endsWith("/role")?{role:body.role,clientId:body.clientId}:{approved:body.approved}),accessVersion:user.accessVersion+1}:user);
    return route.fulfill(json({item:users[0]}));
  });
  await page.route("**/api/clients?*",route=>route.fulfill(json({items:clients})));
  await page.route("**/api/clients/*",route=>{
    const body=route.request().postDataJSON();writes.push({path:new URL(route.request().url()).pathname,body});
    clients=clients.map(client=>client.id==="allog"?{...client,...body,accessVersion:client.accessVersion+1}:client);
    return route.fulfill(json({item:clients[0]}));
  });
  await page.goto("/login");await page.waitForLoadState("networkidle");await page.getByLabel("Email").fill(email);await page.getByLabel("Senha").fill(password);
  await page.getByRole("button",{name:"Entrar",exact:true}).click();await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto("/users");await expect(page.getByRole("heading",{name:"Usuários",exact:true})).toBeVisible();
  return {writes,getUser:()=>users[0],getClient:()=>clients[0],setConflict:(value:boolean)=>{conflict=value;}};
}
test.describe.configure({mode:"serial"});
test.beforeAll(async()=>{const previous=await auth.getUserByEmail(email).catch(()=>null);if(previous) await auth.deleteUser(previous.uid);uid=(await auth.createUser({email,password,emailVerified:true})).uid;});
test.afterAll(async()=>{if(uid) await auth.deleteUser(uid);await deleteApp(app);});

test("user profile and client binding are saved before a distinct approval",async({page})=>{
  const state=await setup(page);const card=page.getByRole("article",{name:"Acesso de pending@example.test"});
  await card.getByLabel("Perfil",{exact:true}).selectOption("CUSTOMER");
  await expect(card.getByRole("button",{name:"Aprovar acesso"})).toBeDisabled();
  await expect(card.getByRole("button",{name:"Salvar perfil"})).toBeDisabled();
  await expect(card.getByLabel("Cliente da conta").locator("option")).toHaveCount(2);
  await card.getByLabel("Cliente da conta").selectOption("allog");
  await card.getByRole("button",{name:"Salvar perfil"}).click();
  await expect(page.getByRole("status").filter({hasText:"aprovação da conta foi mantida"})).toBeVisible();
  expect(state.getUser()).toMatchObject({role:"CUSTOMER",clientId:"allog",approved:false,accessVersion:1});
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({path:"/api/users/pending/role",body:{role:"CUSTOMER",clientId:"allog",expectedVersion:0}});
  await card.getByRole("button",{name:"Aprovar acesso"}).click();
  await expect(card.getByRole("button",{name:"Revogar aprovação"})).toBeVisible();
  expect(state.writes[1]).toMatchObject({path:"/api/users/pending/approve",body:{approved:true,expectedVersion:1}});
  const own=page.getByRole("article",{name:`Acesso de ${email}`});await expect(own.getByLabel("Perfil",{exact:true})).toBeDisabled();
});

test("a conflict preserves the unsaved profile and never approves the user",async({page})=>{
  const state=await setup(page);state.setConflict(true);const card=page.getByRole("article",{name:"Acesso de pending@example.test"});
  await card.getByLabel("Perfil",{exact:true}).selectOption("ANALYST");await card.getByRole("button",{name:"Salvar perfil"}).click();
  await expect(page.getByRole("alert").filter({hasText:"alterado por outra pessoa"})).toBeVisible();
  await expect(card.getByLabel("Perfil",{exact:true})).toHaveValue("ANALYST");
  await expect(card.getByRole("button",{name:"Aprovar acesso"})).toBeDisabled();
  expect(state.getUser()).toMatchObject({role:"OPERATOR",approved:false,accessVersion:0});
});

test("client options save immediately with versions and preserve a disabled sample setting",async({page})=>{
  const state=await setup(page);await page.getByRole("link",{name:"Clientes",exact:true}).click();
  const card=page.getByRole("article",{name:"Configuração de ALLOG"});
  await card.getByLabel("Usa amostra").click();await expect(page.getByRole("status").filter({hasText:"Configuração de ALLOG salva"})).toBeVisible();
  await expect(card.getByLabel("Usa amostra")).not.toBeChecked();
  await card.getByLabel("Acesso ao portal").click();
  await expect.poll(()=>state.getClient().accessVersion).toBe(2);
  expect(state.writes.map(item=>item.body)).toEqual([{usesSample:false,expectedVersion:0},{portalEnabled:false,expectedVersion:1}]);
  await expect(card.getByLabel("Usa amostra")).not.toBeChecked();await page.reload();
  await expect(card.getByLabel("Usa amostra")).not.toBeChecked();await expect(card.getByLabel("Acesso ao portal")).not.toBeChecked();
});

test("the legacy page leads to Users and the mobile menu has no duplicate access screen",async({page})=>{
  await page.setViewportSize({width:390,height:844});await setup(page);await page.goto("/queue-access");
  await expect(page).toHaveURL(/\/users$/);await expect(page.getByRole("link",{name:"Clientes",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Abrir menu"}).click();
  await expect(page.getByRole("link",{name:"Acessos da fila",exact:true})).toHaveCount(0);
  await expect(page.getByRole("link",{name:"Usuários",exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});
