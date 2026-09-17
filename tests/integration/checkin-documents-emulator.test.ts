import {beforeEach,describe,expect,it,vi} from "vitest";
import {randomUUID,createHash} from "node:crypto";
const {files,storageFaults}=vi.hoisted(()=>({files:new Map<string,Buffer>(),storageFaults:{prepare:false}}));
vi.mock("firebase-admin/storage",()=>({getStorage:()=>({bucket:()=>({file:(object:string)=>({
  createResumableUpload:async()=>{if(storageFaults.prepare)throw new Error("Preparation failed");return [`https://storage.googleapis.com/upload/storage/v1/b/demo/o?upload_id=${object}`]},
  exists:async()=>[files.has(object)],
  getMetadata:async()=>[{size:String(files.get(object)?.length??0),generation:"1"}],
  download:async()=>[files.get(object)],
})})})}));
import {adminDb} from "@/lib/firebase/admin";
import {runDocumentCommand,documentConfirmedReplay} from "@/lib/server/checkins/documents";
import {confirmCheckin,createOrRecoverPreRegistration} from "@/lib/server/checkins/service";
import {getDocumentDownload} from "@/lib/server/checkins/document-access";
import {runInternalDocumentCommand} from "@/lib/server/checkins/internal-documents";
import {mutateQueue} from "@/lib/server/checkins/queue-service";
import type {QueueActor} from "@/lib/server/checkins/queue-service";
const enabled=process.env.FIRESTORE_EMULATOR_HOST==="127.0.0.1:8188" && process.env.FIREBASE_PROJECT_ID==="demo-checkin-nf";
const secret="test-only-document-index-key-01234567890";
const identity={driverLicense:"05555930435",driverPhone:"44999197442",plate:"AYZ5E53"};
const form={...identity,driverName:"Motorista fictício",carrierName:"Transportadora teste",vehicleType:"Bitrem",product:"Produto teste",originPlant:"Usina teste",originInvoiceNumbers:"123",remittanceInvoiceNumber:"456",whatsappNoticeAccepted:true,queueLocationAccepted:true};
const area={latitude:-23.9608,longitude:-46.3336,radiusMeters:20000};
async function open(operationId=randomUUID()){return runDocumentCommand({action:"open",operation:"walk-in",operationId,identity});}
async function upload(sessionId:string,content=Buffer.from("%PDF-1.7\nDocumento ficticio\n%%EOF\n")) {
 const attemptId=randomUUID();await runDocumentCommand({action:"begin",sessionId,attemptId,name:"nota.pdf",size:content.length});
 files.set(`checkin-uploads/${sessionId}/${attemptId}/original`,content);
 return {attemptId,result:await runDocumentCommand({action:"finalize",sessionId,attemptId}),content};
}
async function prereg(){return createOrRecoverPreRegistration({rawForm:form,source:"DRIVER",nowIso:new Date().toISOString()},{hmacSecret:secret});}
async function confirm(publicCode:string,sessionId:string,skip=false){const now=new Date().toISOString();return confirmCheckin({...identity,publicCode,document:{sessionId,skip},documentOperation:"walk-in",expectedVersion:1,nowIso:now,location:{...area,accuracyMeters:10,capturedAtIso:now}},{hmacSecret:secret,allowedArea:area});}
async function failure(sessionId:string){const attemptId=randomUUID();await runDocumentCommand({action:"begin",sessionId,attemptId,name:"nota.pdf",size:30});return {attemptId,result:await runDocumentCommand({action:"failed",sessionId,attemptId})};}
describe.skipIf(!enabled)("document confirmation on real local Firestore transactions",()=>{
 beforeEach(async()=>{
  vi.stubEnv("CHECKIN_DOCUMENTS_ENABLED","true");vi.stubEnv("CHECKIN_DOCUMENT_BUCKET","demo-private");vi.stubEnv("CHECKIN_PORTAL_ORIGIN","https://portal.example.test");vi.stubEnv("CHECKIN_INDEX_HMAC_SECRET",secret);
  vi.stubEnv("CHECKIN_DOCUMENT_INTERNAL_ORIGIN","https://line.example.test");
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(null,{status:499})));
  storageFaults.prepare=false;files.clear();for(const ref of await adminDb.listCollections()) await adminDb.recursiveDelete(ref);
 });
 it("reuses an opaque session, validates original, atomically binds it and replays the same visit",async()=>{
  const operationId=randomUUID();const session=await open(operationId);expect((await open(operationId)).sessionId).toBe(session.sessionId);
  const {content}=await upload(session.sessionId);const registration=await prereg();await confirm(registration.publicCode,session.sessionId);
  const rows=await adminDb.collection("checkins").get();expect(rows.size).toBe(1);
  const visit=rows.docs[0].data();expect(visit.document.status).toBe("received");expect(visit.status).toBe("AGUARDANDO_LIBERACAO");
  expect(visit.document.current.sha256).toBe(createHash("sha256").update(content).digest("hex"));expect(files.get(visit.document.current.object)).toEqual(content);
  expect((await adminDb.collection("_checkinDocumentSessions").doc(session.sessionId).get()).data()?.visitId).toBe(rows.docs[0].id);
  await rows.docs[0].ref.update({status:"CONCLUIDO"});expect(await documentConfirmedReplay({sessionId:session.sessionId,skip:false},identity)).toMatchObject({publicCode:registration.publicCode});
 });
 it("unlocks the exception at two distinct failures, never by repeated failure reporting",async()=>{
  const session=await open();const one=await failure(session.sessionId);expect(one.result.canSkip).toBe(false);
  const repeat=await runDocumentCommand({action:"failed",sessionId:session.sessionId,attemptId:one.attemptId});expect(repeat.failures).toBe(1);
  const registration=await prereg();await expect(confirm(registration.publicCode,session.sessionId,true)).rejects.toThrow();
  expect((await adminDb.collection("checkins").get()).docs[0].data().status).toBe("PRE_CADASTRO");
  const two=await failure(session.sessionId);expect(two.result.canSkip).toBe(true);
  await confirm(registration.publicCode,session.sessionId,true);
  const visit=(await adminDb.collection("checkins").get()).docs[0].data();expect(visit.document).toMatchObject({status:"pending",current:null});
 });
 it("does not count a failure report without a started upload",async()=>{
  const session=await open();expect(session.failures).toBe(0);
  await expect(runDocumentCommand({action:"failed",sessionId:session.sessionId,attemptId:randomUUID()})).rejects.toThrow("Tentativa não encontrada");
  expect((await adminDb.collection("_checkinDocumentSessions").doc(session.sessionId).get()).data()?.failures).toBe(0);
 });
 it("treats lost upload response as received if the original already exists",async()=>{
  const session=await open();const attemptId=randomUUID();const bytes=Buffer.from("%PDF-1.7\nTeste\n%%EOF");
  await runDocumentCommand({action:"begin",sessionId:session.sessionId,attemptId,name:"nota.pdf",size:bytes.length});files.set(`checkin-uploads/${session.sessionId}/${attemptId}/original`,bytes);
  expect(await runDocumentCommand({action:"failed",sessionId:session.sessionId,attemptId})).toMatchObject({received:true,failures:0});
 });
 it("rejects a renamed non-document and an actual size mismatch",async()=>{
  const session=await open();const invalid=await upload(session.sessionId,Buffer.from("<html>not a PDF</html>"));expect(invalid.result).toMatchObject({received:false,failures:1});
  const attemptId=randomUUID();await runDocumentCommand({action:"begin",sessionId:session.sessionId,attemptId,name:"nota.pdf",size:100});files.set(`checkin-uploads/${session.sessionId}/${attemptId}/original`,Buffer.from("%PDF-1.7\n%%EOF"));
  expect(await runDocumentCommand({action:"finalize",sessionId:session.sessionId,attemptId})).toMatchObject({received:false,failures:2});
 });
 it("rejects another identity and an expired session",async()=>{
  const session=await open();await upload(session.sessionId);const registration=await prereg();
  await adminDb.collection("_checkinDocumentSessions").doc(session.sessionId).update({identityHash:"other"});
  await expect(confirm(registration.publicCode,session.sessionId)).rejects.toThrow("não pertence");
  await adminDb.collection("_checkinDocumentSessions").doc(session.sessionId).update({expiresAt:Date.now()-1});
  await expect(confirm(registration.publicCode,session.sessionId)).rejects.toThrow("expirada");
 });
 it("serializes duplicate confirmation and produces one visit and one original",async()=>{
  const session=await open();await upload(session.sessionId);const registration=await prereg();
  const results=await Promise.all([confirm(registration.publicCode,session.sessionId),confirm(registration.publicCode,session.sessionId)]);
  expect(results[0].publicCode).toBe(results[1].publicCode);expect((await adminDb.collection("checkins").get()).size).toBe(1);expect(files.size).toBe(1);
 });
 it("keeps documents isolated across two visits of the same plate",async()=>{
  const first=await open();await upload(first.sessionId);const firstRegistration=await prereg();await confirm(firstRegistration.publicCode,first.sessionId);
  const row=(await adminDb.collection("checkins").get()).docs[0];await row.ref.update({status:"CONCLUIDO"});
  for(const lock of (await adminDb.collection("_checkinUniqueLocks").get()).docs) await lock.ref.delete();
  const second=await open();await upload(second.sessionId,Buffer.from("%PDF-1.7\nSegunda visita\n%%EOF"));const secondRegistration=await prereg();await confirm(secondRegistration.publicCode,second.sessionId);
  const rows=(await adminDb.collection("checkins").get()).docs.map(d=>d.data());expect(rows).toHaveLength(2);
  expect(rows[0].plate).toBe(rows[1].plate);expect(rows[0].document.current.object).not.toBe(rows[1].document.current.object);
  expect((await adminDb.collection("_checkinTemporaryObjects").get()).docs.every(d=>d.data().state==="linked")).toBe(true);
 });
 it("does not pretend a new upload replaced a confirmed visit's document",async()=>{
  const first=await open();await upload(first.sessionId);const registration=await prereg();await confirm(registration.publicCode,first.sessionId);
  const other=await open();await upload(other.sessionId);
  await expect(confirm(registration.publicCode,other.sessionId)).rejects.toThrow("Para complementar a nota");
 });
 it("blocks customer downloads before fetching any storage object",async()=>{
  const actor={uid:"customer-test",profile:{role:"CUSTOMER",active:true,approved:true}} as QueueActor;
  await expect(getDocumentDownload(actor,randomUUID())).rejects.toThrow("somente para a Line");
 });
 it("blocks release and call on the server while the document is missing",async()=>{
  const session=await open();await failure(session.sessionId);await failure(session.sessionId);const registration=await prereg();await confirm(registration.publicCode,session.sessionId,true);
  const row=(await adminDb.collection("checkins").get()).docs[0];
  const actor={uid:"analyst",profile:{role:"ANALYST",active:true,approved:true}} as QueueActor;await adminDb.collection("users").doc(actor.uid).set(actor.profile);
  for(const toStatus of ["AGUARDANDO_CHAMADA","CHAMADO"]){await expect(mutateQueue(actor,row.id,{expectedVersion:2,command:{kind:"TRANSITION",toStatus}})).rejects.toThrow("receber a nota fiscal");}
 });

 const pdf=Buffer.from("%PDF-1.7\nDocumento ficticio interno\n%%EOF\n");
 async function pendingInternal(role="ANALYST") {
  const session=await open();await failure(session.sessionId);await failure(session.sessionId);
  const registration=await prereg();await confirm(registration.publicCode,session.sessionId,true);
  const visit=(await adminDb.collection("checkins").get()).docs[0];
  const actor={uid:"line-test",profile:{role,active:true,approved:true,name:"Pessoa Line teste"}} as QueueActor;
  await adminDb.collection("users").doc(actor.uid).set(actor.profile);
  return {actor,visit};
 }
 const beginInput=(size=pdf.length)=>({action:"begin",operationId:randomUUID(),expectedVersion:2,name:"nota-teste.pdf",size});
 async function putInternal(sessionId:string, bytes=pdf) {
  const session=(await adminDb.collection("_checkinDocumentSessions").doc(sessionId).get()).data()!;
  files.set(session.attempts[session.documentId].object,bytes);
  return session;
 }
 it.each(["ANALYST","SUPERVISOR","ADMIN"])("allows %s to attach one original without changing operational status",async(role)=>{
  const {actor,visit}=await pendingInternal(role);
  const input=beginInput();const opened=await runInternalDocumentCommand(actor,visit.id,input);
  expect(opened.received).toBe(false);expect(opened.uploadUrl).toContain("storage.googleapis.com");
  const repeated=await runInternalDocumentCommand(actor,visit.id,input);expect(repeated.sessionId).toBe(opened.sessionId);expect(repeated.uploadUrl).toBe(opened.uploadUrl);
  const s=await putInternal(opened.sessionId);
  const result=await runInternalDocumentCommand(actor,visit.id,{action:"finalize",sessionId:opened.sessionId});
  expect(result.item).toMatchObject({version:3,status:"AGUARDANDO_LIBERACAO",updatedBy:"Pessoa Line teste",document:{status:"received",current:{sha256:createHash("sha256").update(pdf).digest("hex"),previewStatus:"not-applicable"}}});
  expect(result.item?.revisions?.filter(r=>r.action==="Nota fiscal anexada")).toHaveLength(1);
  expect(result.item?.revisions?.find(r=>r.action==="Nota fiscal anexada")).toMatchObject({actor:"Pessoa Line teste",fields:["nota-teste.pdf"]});
  expect((await adminDb.collection("_checkinTemporaryObjects").doc(s.documentId).get()).data()).toMatchObject({state:"linked",visitId:visit.id});
  expect((await adminDb.collection("_checkinDocumentSessions").doc(opened.sessionId).get()).data()).toMatchObject({state:"linked",visitId:visit.id});
  expect(files.get(result.item!.document!.current!.object)).toEqual(pdf);
 });
 it("replays lost finalization and begin responses without duplicate history even after session expiry",async()=>{
  const {actor,visit}=await pendingInternal();const input=beginInput();const s=await runInternalDocumentCommand(actor,visit.id,input);await putInternal(s.sessionId);
  const command={action:"finalize",sessionId:s.sessionId};
  const [a,b]=await Promise.all([runInternalDocumentCommand(actor,visit.id,command),runInternalDocumentCommand(actor,visit.id,command)]);
  expect(a.item?.document?.current?.id).toBe(b.item?.document?.current?.id);
  await adminDb.collection("_checkinDocumentSessions").doc(s.sessionId).update({expiresAt:0});
  expect((await runInternalDocumentCommand(actor,visit.id,command)).item?.version).toBe(3);
  expect((await runInternalDocumentCommand(actor,visit.id,input)).received).toBe(true);
  expect((await visit.ref.collection("revisions").where("action","==","Nota fiscal anexada").get()).size).toBe(1);
 });
 it("serializes two separate uploads and cannot replace the winning document",async()=>{
  const {actor,visit}=await pendingInternal();
  const a=await runInternalDocumentCommand(actor,visit.id,beginInput());const b=await runInternalDocumentCommand(actor,visit.id,beginInput());
  await putInternal(a.sessionId);await putInternal(b.sessionId);
  const results=await Promise.allSettled([a,b].map(s=>runInternalDocumentCommand(actor,visit.id,{action:"finalize",sessionId:s.sessionId})));
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  expect(results.filter(r=>r.status==="rejected")).toHaveLength(1);
  const stored=(await visit.ref.get()).data()!;expect(stored.version).toBe(3);
  expect((await visit.ref.collection("revisions").where("action","==","Nota fiscal anexada").get()).size).toBe(1);
  await expect(runInternalDocumentCommand(actor,visit.id,{...beginInput(),expectedVersion:3})).rejects.toThrow("já tem uma nota");
 },20_000); // Real Firestore transaction retries may exceed Vitest's 5s default.
 it("denies customer/operator/display and rechecks revocation before finalization",async()=>{
  const {actor,visit}=await pendingInternal();
  for(const role of ["CUSTOMER","OPERATOR","DISPLAY"]){await expect(runInternalDocumentCommand({...actor,profile:{...actor.profile,role} as QueueActor["profile"]},visit.id,beginInput())).rejects.toThrow();}
  const s=await runInternalDocumentCommand(actor,visit.id,beginInput());await putInternal(s.sessionId);
  await adminDb.collection("users").doc(actor.uid).update({approved:false});
  await expect(runInternalDocumentCommand(actor,visit.id,{action:"finalize",sessionId:s.sessionId})).rejects.toThrow("Acesso não autorizado");
  await adminDb.collection("users").doc(actor.uid).update({approved:true,role:"CUSTOMER"});
  await expect(runInternalDocumentCommand(actor,visit.id,{action:"finalize",sessionId:s.sessionId})).rejects.toThrow("somente para a equipe Line");
  expect((await visit.ref.get()).data()?.document.status).toBe("pending");
 });
 it("binds sessions to actor and visit and rejects public-session commands",async()=>{
  const {actor,visit}=await pendingInternal();const s=await runInternalDocumentCommand(actor,visit.id,beginInput());await putInternal(s.sessionId);
  const other={...actor,uid:"other-line"};await adminDb.collection("users").doc(other.uid).set(other.profile);
  await expect(runInternalDocumentCommand(other,visit.id,{action:"finalize",sessionId:s.sessionId})).rejects.toThrow("não encontrado");
  await expect(runInternalDocumentCommand(actor,randomUUID(),{action:"finalize",sessionId:s.sessionId})).rejects.toThrow("não encontrado");
  await expect(runDocumentCommand({action:"begin",sessionId:s.sessionId,attemptId:randomUUID(),name:"forged.pdf",size:10})).rejects.toThrow("expirada ou já utilizada");
  const publicSession=await open();await expect(runInternalDocumentCommand(actor,visit.id,{action:"finalize",sessionId:publicSession.sessionId})).rejects.toThrow("não encontrado");
 });
 it("keeps failure and incomplete uploads pending without creating audit success",async()=>{
  const {actor,visit}=await pendingInternal();const input=beginInput();const s=await runInternalDocumentCommand(actor,visit.id,input);
  await expect(runInternalDocumentCommand(actor,visit.id,{action:"finalize",sessionId:s.sessionId})).rejects.toThrow("ainda não foi concluído");
  await putInternal(s.sessionId,Buffer.alloc(pdf.length,65));
  await expect(runInternalDocumentCommand(actor,visit.id,{action:"finalize",sessionId:s.sessionId})).rejects.toThrow("arquivo não foi aceito");
  await expect(runInternalDocumentCommand(actor,visit.id,input)).rejects.toMatchObject({status:410});
  await expect(runInternalDocumentCommand(actor,visit.id,{action:"finalize",sessionId:s.sessionId})).rejects.toMatchObject({status:410});
  expect((await visit.ref.get()).data()?.document.status).toBe("pending");expect((await visit.ref.collection("revisions").where("action","==","Nota fiscal anexada").get()).size).toBe(0);
 });
 it("rejects oversized selection, size mismatch, appended PDF payload and invalid filenames",async()=>{
  const {actor,visit}=await pendingInternal();
  await expect(runInternalDocumentCommand(actor,visit.id,beginInput(10_000_001))).rejects.toThrow();
  await expect(runInternalDocumentCommand(actor,visit.id,{...beginInput(),name:"../nota.pdf"})).rejects.toThrow();
  const mismatch=await runInternalDocumentCommand(actor,visit.id,beginInput(pdf.length+1));await putInternal(mismatch.sessionId);
  await expect(runInternalDocumentCommand(actor,visit.id,{action:"finalize",sessionId:mismatch.sessionId})).rejects.toMatchObject({status:422});
  const hybrid=Buffer.concat([pdf,Buffer.from("<script>bad</script>")]);
  const s=await runInternalDocumentCommand(actor,visit.id,beginInput(hybrid.length));await putInternal(s.sessionId,hybrid);
  await expect(runInternalDocumentCommand(actor,visit.id,{action:"finalize",sessionId:s.sessionId})).rejects.toMatchObject({status:422});
 });
 it("does not attach after the visit version changes or cleanup claims a session",async()=>{
  const {actor,visit}=await pendingInternal();const s=await runInternalDocumentCommand(actor,visit.id,beginInput());await putInternal(s.sessionId);
  await visit.ref.update({version:3,booking:"Outra pessoa alterou"});
  await expect(runInternalDocumentCommand(actor,visit.id,{action:"finalize",sessionId:s.sessionId})).rejects.toThrow("visita foi alterada");
  await adminDb.collection("_checkinDocumentSessions").doc(s.sessionId).update({state:"deleting"});
  await expect(runInternalDocumentCommand(actor,visit.id,{action:"finalize",sessionId:s.sessionId})).rejects.toMatchObject({status:410});
  expect((await visit.ref.get()).data()?.booking).toBe("Outra pessoa alterou");
 });
 it("handles expiry, metadata changes and interrupted preparation without reusing an upload",async()=>{
  const {actor,visit}=await pendingInternal();const input=beginInput();const s=await runInternalDocumentCommand(actor,visit.id,input);
  await expect(runInternalDocumentCommand(actor,visit.id,{...input,name:"diferente.pdf"})).rejects.toThrow("outro envio");
  const ref=adminDb.collection("_checkinDocumentSessions").doc(s.sessionId);const state=(await ref.get()).data()!;
  const attempt={...state.attempts[state.documentId],state:"starting"};delete attempt.uploadUrl;
  await ref.update({attempts:{[state.documentId]:attempt}});
  await expect(runInternalDocumentCommand(actor,visit.id,input)).rejects.toMatchObject({status:409});
  await expect(runInternalDocumentCommand(actor,visit.id,{action:"finalize",sessionId:s.sessionId})).rejects.toMatchObject({status:409});
  await ref.update({createdAt:Date.now()-70_000});await expect(runInternalDocumentCommand(actor,visit.id,input)).rejects.toMatchObject({status:410});
  await ref.update({expiresAt:0});await expect(runInternalDocumentCommand(actor,visit.id,{action:"finalize",sessionId:s.sessionId})).rejects.toMatchObject({status:410});
 });
 it("creates an async preview for images and retains the visit's other pending issues",async()=>{
  const {actor,visit}=await pendingInternal();await visit.ref.update({issues:[{id:"document-check",description:"Conferir dados",resolved:false}]});
  const jpeg=Buffer.from([255,216,255,224,0,2,255,217]);
  const s=await runInternalDocumentCommand(actor,visit.id,{...beginInput(jpeg.length),name:"foto.jpg"});const state=await putInternal(s.sessionId,jpeg);
  const result=await runInternalDocumentCommand(actor,visit.id,{action:"finalize",sessionId:s.sessionId});
  expect(result.item?.issues).toEqual([{id:"document-check",description:"Conferir dados",resolved:false}]);
  expect(result.item?.status).toBe("AGUARDANDO_LIBERACAO");
  expect((await adminDb.collection("_checkinPreviewJobs").doc(state.documentId).get()).data()).toMatchObject({visitId:visit.id,documentId:state.documentId,state:"pending",generation:"1"});
 });
 it("refuses missing visits, profiles, disabled runtime and unknown commands",async()=>{
  const {actor,visit}=await pendingInternal();
  await expect(runInternalDocumentCommand(actor,randomUUID(),beginInput())).rejects.toMatchObject({status:404});
  await expect(runInternalDocumentCommand(actor,visit.id,{...beginInput(),status:"CHAMADO"})).rejects.toThrow();
  vi.stubEnv("CHECKIN_DOCUMENT_INTERNAL_ORIGIN","");await expect(runInternalDocumentCommand(actor,visit.id,beginInput())).rejects.toMatchObject({status:503});
  vi.stubEnv("CHECKIN_DOCUMENT_INTERNAL_ORIGIN","https://line.example.test");
  await adminDb.collection("users").doc(actor.uid).delete();await expect(runInternalDocumentCommand(actor,visit.id,beginInput())).rejects.toMatchObject({status:403});
 });
 it("handles storage preparation failure with a new operation and guards session quota",async()=>{
  const {actor,visit}=await pendingInternal();const input=beginInput();storageFaults.prepare=true;
  await expect(runInternalDocumentCommand(actor,visit.id,input)).rejects.toMatchObject({status:410});
  storageFaults.prepare=false;
  await expect(runInternalDocumentCommand(actor,visit.id,input)).rejects.toMatchObject({status:410});
  expect((await runInternalDocumentCommand(actor,visit.id,beginInput())).uploadUrl).toBeTruthy();
  const quotaId=`internal_${createHash("sha256").update(actor.uid).digest("hex")}`;
  await adminDb.collection("_checkinDocumentQuotas").doc(quotaId).set({count:60,until:Date.now()+60_000});
  await expect(runInternalDocumentCommand(actor,visit.id,beginInput())).rejects.toMatchObject({status:429});
 });
});
