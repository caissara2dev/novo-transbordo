import {beforeEach,describe,expect,it,vi} from "vitest";
import {randomUUID,createHash} from "node:crypto";
const {files,storageFaults,signedReads}=vi.hoisted(()=>({files:new Map<string,Buffer>(),storageFaults:{prepare:false},signedReads:[] as {object:string;options:Record<string,unknown>}[]}));
vi.mock("firebase-admin/storage",()=>({getStorage:()=>({bucket:()=>({file:(object:string)=>({
  createResumableUpload:async()=>{if(storageFaults.prepare)throw new Error("Preparation failed");return [`https://storage.googleapis.com/upload/storage/v1/b/demo/o?upload_id=${object}`]},
  exists:async()=>[files.has(object)],
  getMetadata:async()=>[{size:String(files.get(object)?.length??0),generation:"1"}],
  download:async()=>[files.get(object)],
  getSignedUrl:async(options:Record<string,unknown>)=>{signedReads.push({object,options});return ["https://storage.example.test/private-test-document"]},
})})})}));
import {adminDb} from "@/lib/firebase/admin";
import {runDocumentCommand,documentConfirmedReplay} from "@/lib/server/checkins/documents";
import {confirmCheckin,createOrRecoverPreRegistration} from "@/lib/server/checkins/service";
import {getDocumentDownload,listDocumentVersions} from "@/lib/server/checkins/document-access";
import {runInternalDocumentCommand} from "@/lib/server/checkins/internal-documents";
import {requestDocumentDeletion} from "@/lib/server/checkins/document-deletion";
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
  storageFaults.prepare=false;files.clear();signedReads.length=0;for(const ref of await adminDb.listCollections()) await adminDb.recursiveDelete(ref);
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
  expect(results[0].publicCode).toBe(results[1].publicCode);
  const visits=await adminDb.collection("checkins").get();expect(visits.size).toBe(1);
  const visit=visits.docs[0];expect(visit.data()).toMatchObject({status:"AGUARDANDO_LIBERACAO",version:2,document:{status:"received",sessionId:session.sessionId}});
  expect((await adminDb.collection("_checkinDocumentSessions").doc(session.sessionId).get()).data()).toMatchObject({state:"linked",visitId:visit.id});
  expect((await visit.ref.collection("revisions").where("action","==","CHECKIN_CONFIRMED").get()).size).toBe(1);
  expect(files.size).toBe(1);
 },20_000); // Real lock contention and SDK retry backoff are intentional; this is not a latency SLA.
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
 },20_000); // Intentional transaction contention can trigger Firestore SDK retry backoff.
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

 async function receivedInternal(role="ANALYST") {
  const context=await pendingInternal(role);
  const input=beginInput();
  const session=await runInternalDocumentCommand(context.actor,context.visit.id,input);
  await putInternal(session.sessionId);
  const response=await runInternalDocumentCommand(context.actor,context.visit.id,{action:"finalize",sessionId:session.sessionId});
  return {...context,original:response.item!.document!.current!,attachmentSession:session.sessionId};
 }
 async function beginReplacement(context:Awaited<ReturnType<typeof receivedInternal>>,name="nota-corrigida.pdf",bytes=pdf) {
  const stored=(await context.visit.ref.get()).data()!;
  const input={...beginInput(bytes.length),name,expectedVersion:stored.version,replaceDocumentId:stored.document.current.id};
  return {input,response:await runInternalDocumentCommand(context.actor,context.visit.id,input)};
 }
 async function finishReplacement(context:Awaited<ReturnType<typeof receivedInternal>>,name="nota-corrigida.pdf",bytes=pdf) {
  const {input,response}=await beginReplacement(context,name,bytes);
  await putInternal(response.sessionId,bytes);
  const result=await runInternalDocumentCommand(context.actor,context.visit.id,{action:"finalize",sessionId:response.sessionId});
  return {input,response,result};
 }

 it.each(["ANALYST","SUPERVISOR","ADMIN"])("allows %s to replace an original atomically, retain its 90-day history and preserve operational data",async(role)=>{
  const context=await receivedInternal(role);const {actor,visit,original}=context;
  const issues=[{id:"sample-check",description:"Amostra pendente",resolved:false}];
  await visit.ref.update({status:"CHAMADO",booking:"BK-INTACTO",sample:"Em análise",observation:"Conferir com motorista",issues});
  const bytes=Buffer.from("%PDF-1.7\nNota corrigida de teste\n%%EOF\n");
  const {response}=await beginReplacement(context,"nota-corrigida.pdf",bytes);
  expect((await visit.ref.get()).data()!.document.current).toEqual(original);
  expect((await adminDb.collection("_checkinDocumentVersions").get()).empty).toBe(true);
  await putInternal(response.sessionId,bytes);const before=Date.now();
  const result=await runInternalDocumentCommand(actor,visit.id,{action:"finalize",sessionId:response.sessionId});const after=Date.now();
  const current=result.item!.document!.current!;
  expect(current.id).not.toBe(original.id);
  expect(current.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(result.item).toMatchObject({version:4,status:"CHAMADO",booking:"BK-INTACTO",sample:"Em análise",observation:"Conferir com motorista",issues});
  expect(files.get(original.object)).toEqual(pdf);expect(files.get(current.object)).toEqual(bytes);
  const archived=(await adminDb.collection("_checkinDocumentVersions").doc(original.id).get()).data()!;
  expect(archived).toMatchObject({visitId:visit.id,document:original,state:"available",actorUid:actor.uid,replacedBy:"Pessoa Line teste",replacementDocumentId:current.id});
  expect(Date.parse(archived.replacedAtIso)).toBeGreaterThanOrEqual(before);expect(Date.parse(archived.replacedAtIso)).toBeLessThanOrEqual(after);
  expect(archived.expiresAt-Date.parse(archived.replacedAtIso)).toBe(90*24*60*60*1000);
  const history=await visit.ref.collection("revisions").where("action","==","Nota fiscal substituída").get();
  expect(history.size).toBe(1);
  expect(history.docs[0].data()).toMatchObject({actor:"Pessoa Line teste",actorUid:actor.uid,actorRole:role,documentId:current.id,changedFields:[original.name,"nota-corrigida.pdf"],previousVersion:3,newVersion:4});
  const listed=await listDocumentVersions(actor,visit.id);
  expect(listed.items).toHaveLength(1);expect(listed.items[0]).toMatchObject({id:original.id,name:original.name,size:original.size,contentType:"application/pdf",replacedBy:"Pessoa Line teste",state:"available",available:true});
  expect(listed.items[0].expiresAtIso).toBe(new Date(archived.expiresAt).toISOString());
 });
 it("cannot replace without naming the current document, even with the current visit version",async()=>{
  const context=await receivedInternal();const {actor,visit}=context;
  await expect(runInternalDocumentCommand(actor,visit.id,{...beginInput(),expectedVersion:3})).rejects.toMatchObject({status:409});
  await expect(runInternalDocumentCommand(actor,visit.id,{...beginInput(),expectedVersion:3,replaceDocumentId:randomUUID()})).rejects.toMatchObject({status:409});
  await expect(runInternalDocumentCommand(actor,visit.id,{...beginInput(),expectedVersion:2,replaceDocumentId:context.original.id})).rejects.toMatchObject({status:409});
  await expect(runInternalDocumentCommand(actor,visit.id,{...beginInput(),expectedVersion:3,replaceDocumentId:"../not-a-document"})).rejects.toThrow();
  expect((await adminDb.collection("_checkinDocumentVersions").get()).empty).toBe(true);
  expect((await visit.ref.get()).data()!.document.current.id).toBe(context.original.id);
 });
 it("does not accept a replacement marker for a visit still missing its document",async()=>{
  const {actor,visit}=await pendingInternal();
  await expect(runInternalDocumentCommand(actor,visit.id,{...beginInput(),replaceDocumentId:randomUUID()})).rejects.toMatchObject({status:409});
  expect((await visit.ref.get()).data()!.document.status).toBe("pending");
 });
 it("keeps the old original readable when a replacement is incomplete or invalid",async()=>{
  const context=await receivedInternal();const {actor,visit,original}=context;
  const {response}=await beginReplacement(context);
  await expect(runInternalDocumentCommand(actor,visit.id,{action:"finalize",sessionId:response.sessionId})).rejects.toMatchObject({status:409});
  await putInternal(response.sessionId,Buffer.alloc(pdf.length,65));
  await expect(runInternalDocumentCommand(actor,visit.id,{action:"finalize",sessionId:response.sessionId})).rejects.toMatchObject({status:422});
  const stored=(await visit.ref.get()).data()!;expect(stored.version).toBe(3);expect(stored.document.current).toEqual(original);
  expect((await adminDb.collection("_checkinDocumentVersions").get()).empty).toBe(true);
  expect((await visit.ref.collection("revisions").where("action","==","Nota fiscal substituída").get()).empty).toBe(true);
  expect((await getDocumentDownload(actor,visit.id)).name).toBe(original.name);
  expect(signedReads.at(-1)).toMatchObject({object:original.object,options:{queryParams:{generation:original.generation}}});
 });
 it("serializes competing replacements so exactly one wins and the other cannot overwrite it",async()=>{
  const context=await receivedInternal();const a=await beginReplacement(context,"nota-a.pdf");const b=await beginReplacement(context,"nota-b.pdf");
  await putInternal(a.response.sessionId);await putInternal(b.response.sessionId);
  const results=await Promise.allSettled([a,b].map(s=>runInternalDocumentCommand(context.actor,context.visit.id,{action:"finalize",sessionId:s.response.sessionId})));
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  const loser=results.find(r=>r.status==="rejected") as PromiseRejectedResult;expect(loser.reason).toMatchObject({status:409});
  expect((await context.visit.ref.get()).data()!.version).toBe(4);
  expect((await adminDb.collection("_checkinDocumentVersions").get()).size).toBe(1);
  expect((await context.visit.ref.collection("revisions").where("action","==","Nota fiscal substituída").get()).size).toBe(1);
 },20_000);
 it("replays old attachment and replacement receipts after a later replacement without restoring earlier originals",async()=>{
  const context=await receivedInternal();const first=await finishReplacement(context,"primeira-troca.pdf");const second=await finishReplacement(context,"segunda-troca.pdf");
  await adminDb.collection("_checkinDocumentSessions").doc(first.response.sessionId).update({expiresAt:0});
  const current=second.result.item!.document!.current!;
  for(const sessionId of [context.attachmentSession,first.response.sessionId]) {
   const replay=await runInternalDocumentCommand(context.actor,context.visit.id,{action:"finalize",sessionId});
   expect(replay.received).toBe(true);expect(replay.item?.document?.current?.id).toBe(current.id);
  }
  const repeated=await runInternalDocumentCommand(context.actor,context.visit.id,first.input);
  expect(repeated.received).toBe(true);expect(repeated.item?.document?.current?.id).toBe(current.id);
  expect((await context.visit.ref.get()).data()!.version).toBe(5);
  expect((await adminDb.collection("_checkinDocumentVersions").get()).size).toBe(2);
  expect((await context.visit.ref.collection("revisions").where("action","==","Nota fiscal substituída").get()).size).toBe(2);
  await expect(runInternalDocumentCommand(context.actor,context.visit.id,{...beginInput(),expectedVersion:5,replaceDocumentId:context.original.id})).rejects.toMatchObject({status:409});
 });
 it("binds replacement intent to the operation and refuses public or other-actor finalization",async()=>{
  const context=await receivedInternal();const {input,response}=await beginReplacement(context);const {actor,visit}=context;
  await expect(runInternalDocumentCommand(actor,visit.id,{...input,replaceDocumentId:randomUUID()})).rejects.toMatchObject({status:409});
  const withoutReplacement={...input} as Record<string,unknown>;delete withoutReplacement.replaceDocumentId;
  await expect(runInternalDocumentCommand(actor,visit.id,withoutReplacement)).rejects.toMatchObject({status:409});
  await putInternal(response.sessionId);
  const other={...actor,uid:"different-line-user"};await adminDb.collection("users").doc(other.uid).set(other.profile);
  await expect(runInternalDocumentCommand(other,visit.id,{action:"finalize",sessionId:response.sessionId})).rejects.toMatchObject({status:404});
  await expect(runDocumentCommand({action:"finalize",sessionId:response.sessionId,attemptId:context.original.id})).rejects.toThrow();
  expect((await visit.ref.get()).data()!.document.current.id).toBe(context.original.id);
 });
 it.each([{active:false},{approved:false},{role:"CUSTOMER"}])("rechecks revoked access %j before accepting a replacement",async(profileChange)=>{
  const context=await receivedInternal();const {response}=await beginReplacement(context);await putInternal(response.sessionId);
  await adminDb.collection("users").doc(context.actor.uid).update(profileChange);
  await expect(runInternalDocumentCommand(context.actor,context.visit.id,{action:"finalize",sessionId:response.sessionId})).rejects.toMatchObject({status:403});
  expect((await context.visit.ref.get()).data()!.document.current.id).toBe(context.original.id);
  expect((await adminDb.collection("_checkinDocumentVersions").get()).empty).toBe(true);
 });
 it("denies customer, operator and display access to previous originals without creating signed URLs",async()=>{
  const context=await receivedInternal();await finishReplacement(context);
  for(const role of ["CUSTOMER","OPERATOR","DISPLAY"]) {
   const actor={...context.actor,profile:{...context.actor.profile,role} as QueueActor["profile"]};
   await expect(listDocumentVersions(actor,context.visit.id)).rejects.toMatchObject({status:403});
   await expect(getDocumentDownload(actor,context.visit.id,false,context.original.id)).rejects.toMatchObject({status:403});
  }
  expect(signedReads).toHaveLength(0);
 });
 it.each(["ANALYST","SUPERVISOR","ADMIN"])("allows %s to read only unexpired previous originals belonging to the requested visit",async(role)=>{
  const context=await receivedInternal(role);await finishReplacement(context);
  const result=await getDocumentDownload(context.actor,context.visit.id,false,context.original.id);
  expect(result.name).toBe(context.original.name);expect(result.expiresInSeconds).toBeGreaterThan(0);expect(result.expiresInSeconds).toBeLessThanOrEqual(60);
  expect(signedReads).toHaveLength(1);
  expect(signedReads[0]).toMatchObject({object:context.original.object,options:{queryParams:{generation:context.original.generation},responseType:"application/pdf"}});
  expect(Number(signedReads[0].options.expires)).toBeGreaterThan(Date.now());
  expect(Number(signedReads[0].options.expires)).toBeLessThanOrEqual(Date.now()+60_000);
  const secondVisitId=randomUUID();await adminDb.collection("checkins").doc(secondVisitId).set({...((await context.visit.ref.get()).data()!),publicCode:"LT-TESTONLY"});
  await expect(getDocumentDownload(context.actor,secondVisitId,false,context.original.id)).rejects.toMatchObject({status:404});
  await expect(getDocumentDownload(context.actor,context.visit.id,false,randomUUID())).rejects.toMatchObject({status:404});
  expect(signedReads).toHaveLength(1);
 });
 it("caps an old document's signed access at its retention deadline and pins preview generations",async()=>{
  const context=await receivedInternal();
  await context.visit.ref.update({"document.current.previewStatus":"ready","document.current.previewObject":"private/old-preview.jpg","document.current.previewGeneration":"23"});
  await finishReplacement(context);
  const expiresAt=Date.now()+10_000;
  await adminDb.collection("_checkinDocumentVersions").doc(context.original.id).update({expiresAt});
  await getDocumentDownload(context.actor,context.visit.id,false,context.original.id);
  await getDocumentDownload(context.actor,context.visit.id,true,context.original.id);
  expect(signedReads).toHaveLength(2);
  expect(signedReads[0]).toMatchObject({object:context.original.object,options:{expires:expiresAt,queryParams:{generation:context.original.generation}}});
  expect(signedReads[1]).toMatchObject({object:"private/old-preview.jpg",options:{expires:expiresAt,queryParams:{generation:"23"},responseType:"image/jpeg"}});
 });
 it("replaces a PDF with a photo and queues the new preview without changing the archived original",async()=>{
  const context=await receivedInternal();const photo=Buffer.from([255,216,255,224,0,2,255,217]);
  const replacement=await finishReplacement(context,"foto-corrigida.jpg",photo);const current=replacement.result.item!.document!.current!;
  expect(current).toMatchObject({name:"foto-corrigida.jpg",contentType:"image/jpeg",previewStatus:"pending"});
  expect((await adminDb.collection("_checkinPreviewJobs").doc(current.id).get()).data()).toMatchObject({visitId:context.visit.id,documentId:current.id,object:current.object,generation:current.generation,state:"pending"});
  expect((await adminDb.collection("_checkinDocumentVersions").doc(context.original.id).get()).data()!.document).toEqual(context.original);
  expect(replacement.result.item!.status).toBe("AGUARDANDO_LIBERACAO");
 });
 it("stops authorizing expired versions exactly at their deadline and keeps the textual substitution history",async()=>{
  const context=await receivedInternal();await finishReplacement(context);
  const archived=adminDb.collection("_checkinDocumentVersions").doc(context.original.id);
  const deadline=Date.now()-1;await archived.update({expiresAt:deadline});
  const list=await listDocumentVersions(context.actor,context.visit.id);
  expect(list.items[0]).toMatchObject({id:context.original.id,available:false});
  await expect(getDocumentDownload(context.actor,context.visit.id,false,context.original.id)).rejects.toMatchObject({status:410});
  expect(signedReads).toHaveLength(0);
  // Expiration/deletion of bytes must not cascade into the visit's permanent audit trail.
  files.delete(context.original.object);await archived.update({state:"deleted"});
  const audit=await context.visit.ref.collection("revisions").where("action","==","Nota fiscal substituída").get();
  expect(audit.size).toBe(1);expect(audit.docs[0].data().changedFields).toEqual([context.original.name,"nota-corrigida.pdf"]);
  expect((await listDocumentVersions(context.actor,context.visit.id)).items[0].available).toBe(false);
  expect((await context.visit.ref.get()).data()!.document.status).toBe("received");
 });
 it("rechecks current profile for both history and original download after access was revoked",async()=>{
  const context=await receivedInternal();await finishReplacement(context);
  await adminDb.collection("users").doc(context.actor.uid).update({active:false});
  await expect(listDocumentVersions(context.actor,context.visit.id)).rejects.toMatchObject({status:403});
  await expect(getDocumentDownload(context.actor,context.visit.id,false,context.original.id)).rejects.toMatchObject({status:403});
  await expect(getDocumentDownload(context.actor,context.visit.id)).rejects.toMatchObject({status:403});
  expect(signedReads).toHaveLength(0);
 });
 it("paginates previous documents without leaking object paths or other visits",async()=>{
  const context=await receivedInternal();const otherVisit=randomUUID();const created=Date.now();const ids:string[]=[];
  const batch=adminDb.batch();
  for(let index=0;index<27;index++) {
   const id=randomUUID();ids.push(id);
   batch.set(adminDb.collection("_checkinDocumentVersions").doc(id),{visitId:context.visit.id,document:{...context.original,id,name:`anterior-${index}.pdf`,object:`private/${id}`},state:"available",replacedAtIso:new Date(created-index*1000).toISOString(),expiresAt:created+90*24*60*60*1000,replacedBy:"Pessoa Line teste",actorUid:context.actor.uid,replacementDocumentId:context.original.id});
  }
  const foreignId=randomUUID();batch.set(adminDb.collection("_checkinDocumentVersions").doc(foreignId),{visitId:otherVisit,document:{...context.original,id:foreignId},state:"available",replacedAtIso:new Date(created).toISOString(),expiresAt:created+100_000,replacedBy:"Outra pessoa",actorUid:context.actor.uid,replacementDocumentId:context.original.id});
  await batch.commit();
  let page=await listDocumentVersions(context.actor,context.visit.id);expect(page.nextCursor).toBeTruthy();
  const collected=[...page.items];const cursors=new Set<string>();
  while(page.nextCursor) {
   expect(cursors.has(page.nextCursor)).toBe(false);cursors.add(page.nextCursor);
   page=await listDocumentVersions(context.actor,context.visit.id,page.nextCursor);collected.push(...page.items);
  }
  expect(collected.map(v=>v.id)).toEqual(ids);
  expect(new Set(collected.map(v=>v.id)).size).toBe(27);expect(collected.map(v=>v.id)).not.toContain(foreignId);
  for(const version of collected) {expect(version).not.toHaveProperty("object");expect(version).not.toHaveProperty("generation");expect(version).not.toHaveProperty("actorUid");expect(version).not.toHaveProperty("document");}
  const first=await listDocumentVersions(context.actor,context.visit.id);
  await expect(listDocumentVersions(context.actor,otherVisit,first.nextCursor!)).rejects.toThrow();
 });

 const deletion=(documentId:string,expectedVersion=3)=>({action:"delete",operationId:randomUUID(),documentId,expectedVersion,reason:"Documento fictício para teste de exclusão"});
 it.each(["ADMIN","SUPERVISOR"])("allows %s to request exact deletion once and keeps status and saved events",async(role)=>{
  const {actor,visit,original}=await receivedInternal(role);
  await visit.ref.update({status:"EM_DESCARGA",linkedEventId:"saved-event",booking:"INTACTO"});
  const input=deletion(original.id);
  const first=await requestDocumentDeletion(actor,visit.id,input);
  expect(first.item).toMatchObject({status:"EM_DESCARGA",version:4,booking:"INTACTO",document:{status:"pending",current:null}});
  expect((await visit.ref.get()).data()?.linkedEventId).toBe("saved-event");
  expect(files.has(original.object)).toBe(true); // Worker, not the web request, owns physical deletion.
  const archive=(await adminDb.collection("_checkinDocumentVersions").doc(original.id).get()).data()!;
  expect(archive).toMatchObject({kind:"manual-deletion",state:"deletion-requested",document:original,deletion:{reason:input.reason,actorRole:role,source:"manual"}});
  await expect(getDocumentDownload(actor,visit.id)).rejects.toMatchObject({status:404});
  await expect(getDocumentDownload(actor,visit.id,false,original.id)).rejects.toMatchObject({status:410});
  expect((await requestDocumentDeletion(actor,visit.id,input)).item.version).toBe(4);
  expect((await visit.ref.collection("revisions").where("action","==","Exclusão de nota solicitada").get()).size).toBe(1);
  const fresh=await runInternalDocumentCommand(actor,visit.id,{...beginInput(),expectedVersion:4});await putInternal(fresh.sessionId);
  const received=await runInternalDocumentCommand(actor,visit.id,{action:"finalize",sessionId:fresh.sessionId});
  const replay=await requestDocumentDeletion(actor,visit.id,input);
  expect(replay.item.document?.current?.id).toBe(received.item?.document?.current?.id);
  await expect(requestDocumentDeletion(actor,visit.id,{...input,documentId:replay.item.document!.current!.id})).rejects.toMatchObject({status:409});
 });
 it.each(["ANALYST","CUSTOMER","OPERATOR","DISPLAY"])("refuses NF deletion by %s",async(role)=>{
  const context=await receivedInternal("ADMIN");
  const actor={...context.actor,profile:{...context.actor.profile,role} as QueueActor["profile"]};
  await expect(requestDocumentDeletion(actor,context.visit.id,deletion(context.original.id))).rejects.toMatchObject({status:403});
  expect((await context.visit.ref.get()).data()?.document.current.id).toBe(context.original.id);
 });
 it("requires reason, exact target/version and current permission even when replaying",async()=>{
  const {actor,visit,original}=await receivedInternal("ADMIN");const input=deletion(original.id);
  await expect(requestDocumentDeletion(actor,visit.id,{...input,reason:"  "})).rejects.toThrow();
  await expect(requestDocumentDeletion(actor,visit.id,{...input,expectedVersion:2})).rejects.toMatchObject({status:409});
  await expect(requestDocumentDeletion(actor,visit.id,{...input,documentId:randomUUID()})).rejects.toMatchObject({status:404});
  await visit.ref.update({pendingOfficialMutation:{id:"busy"}});
  await expect(requestDocumentDeletion(actor,visit.id,input)).rejects.toMatchObject({status:409});
  await visit.ref.update({pendingOfficialMutation:null});
  await requestDocumentDeletion(actor,visit.id,input);
  await adminDb.collection("users").doc(actor.uid).update({role:"ANALYST"});
  await expect(requestDocumentDeletion(actor,visit.id,input)).rejects.toMatchObject({status:403});
 });
 it("deletes an archived version without changing current document or its 90-day expiry",async()=>{
  const context=await receivedInternal("SUPERVISOR");const latest=await finishReplacement(context);
  const archiveRef=adminDb.collection("_checkinDocumentVersions").doc(context.original.id);
  const before=(await archiveRef.get()).data()!;
  const result=await requestDocumentDeletion(context.actor,context.visit.id,deletion(context.original.id,4));
  expect(result.item.document?.current).toEqual(latest.result.item?.document?.current);
  expect((await archiveRef.get()).data()).toMatchObject({expiresAt:before.expiresAt,state:"deletion-requested"});
  expect((await listDocumentVersions(context.actor,context.visit.id)).items[0]).toMatchObject({available:false,deletion:{source:"manual"}});
  expect((await getDocumentDownload(context.actor,context.visit.id)).name).toBe("nota-corrigida.pdf");
 });
 it("serializes deletion against replacement and never deletes the winning replacement",async()=>{
  const context=await receivedInternal("ADMIN");const replacement=await beginReplacement(context);await putInternal(replacement.response.sessionId);
  const results=await Promise.allSettled([
   requestDocumentDeletion(context.actor,context.visit.id,deletion(context.original.id)),
   runInternalDocumentCommand(context.actor,context.visit.id,{action:"finalize",sessionId:replacement.response.sessionId}),
  ]);
  expect(results.filter(item=>item.status==="fulfilled")).toHaveLength(1);
  expect((await context.visit.ref.get()).data()?.version).toBe(4);
 },20_000);
 it("preserves the closure deadline on replacement and blocks current download and upload after expiry",async()=>{
  const context=await receivedInternal("ADMIN");
  const expiresAt=new Date(Date.now()+50_000).toISOString();
  await context.visit.ref.update({status:"CONCLUIDO",closedAtIso:"2025-09-17T10:00:00.000Z",documentExpiresAtIso:expiresAt});
  await finishReplacement(context);
  expect((await context.visit.ref.get()).data()?.documentExpiresAtIso).toBe(expiresAt);
  await getDocumentDownload(context.actor,context.visit.id);
  expect(signedReads.at(-1)?.options.expires).toBe(Date.parse(expiresAt));
  const upload=await beginReplacement(context);await putInternal(upload.response.sessionId);
  await context.visit.ref.update({documentExpiresAtIso:new Date(Date.now()-1).toISOString()});
  await expect(getDocumentDownload(context.actor,context.visit.id)).rejects.toMatchObject({status:410});
  await expect(beginReplacement(context)).rejects.toMatchObject({status:410});
  await expect(runInternalDocumentCommand(context.actor,context.visit.id,{action:"finalize",sessionId:upload.response.sessionId})).rejects.toMatchObject({status:410});
  // Earlier replaced files retain their own independently calculated 90-day deadline.
  expect((await getDocumentDownload(context.actor,context.visit.id,false,context.original.id)).name).toBe(context.original.name);
 });
});
