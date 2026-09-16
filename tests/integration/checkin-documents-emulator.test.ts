import {beforeEach,describe,expect,it,vi} from "vitest";
import {randomUUID,createHash} from "node:crypto";
const {files}=vi.hoisted(()=>({files:new Map<string,Buffer>()}));
vi.mock("firebase-admin/storage",()=>({getStorage:()=>({bucket:()=>({file:(object:string)=>({
  createResumableUpload:async()=>[`https://storage.googleapis.com/upload/storage/v1/b/demo/o?upload_id=${object}`],
  exists:async()=>[files.has(object)],
  getMetadata:async()=>[{size:String(files.get(object)?.length??0),generation:"1"}],
  download:async()=>[files.get(object)],
})})})}));
import {adminDb} from "@/lib/firebase/admin";
import {runDocumentCommand,documentConfirmedReplay} from "@/lib/server/checkins/documents";
import {confirmCheckin,createOrRecoverPreRegistration} from "@/lib/server/checkins/service";
import {getDocumentDownload} from "@/lib/server/checkins/document-access";
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
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(null,{status:499})));
  files.clear();for(const ref of await adminDb.listCollections()) await adminDb.recursiveDelete(ref);
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
});
