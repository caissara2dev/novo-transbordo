import "server-only";
import { createHash, createHmac } from "node:crypto";
import { getStorage } from "firebase-admin/storage";
import { z } from "zod";
import { adminDb } from "@/lib/firebase/admin";
import { HttpError } from "@/lib/domain/errors";
import { detectDocumentType, DOCUMENT_MAX_BYTES, DOCUMENT_SESSION_MS, type DocumentReceipt, type VisitDocument } from "@/lib/domain/checkin-document";
import { normalizeIdentityInput } from "./service";
import { resolvePublicCheckinVersion } from "./public-query";
import { documentEnvironment } from "./document-environment";

const collection = "_checkinDocumentSessions";
const capability = z.string().regex(/^[a-f0-9]{64}$/);
const identitySchema = z.object({ driverLicense:z.string().max(32),driverPhone:z.string().max(32),plate:z.string().max(16) }).strict();
export const documentCommandSchema = z.discriminatedUnion("action", [
  z.object({ action:z.literal("open"), operationId:z.string().uuid(), operation:z.enum(["confirm","walk-in"]), identity:identitySchema, publicCode:z.string().max(16).optional() }).strict(),
  z.object({ action:z.literal("begin"), sessionId:capability, attemptId:z.string().uuid(), name:z.string().min(1).max(200), size:z.number().int().positive().max(DOCUMENT_MAX_BYTES) }).strict(),
  z.object({ action:z.enum(["status","finalize","failed"]), sessionId:capability, attemptId:z.string().uuid() }).strict(),
]);
export type DocumentCommand = z.infer<typeof documentCommandSchema>;
type Attempt = { id:string; object:string; name:string; size:number; state:"starting"|"uploading"|"failed"|"received"; uploadUrl?:string };
type Session = {
  purpose?: string;
  identityHash:string; operation:"confirm"|"walk-in"; publicCode:string|null;
  createdAt:number; expiresAt:number; state:"open"|"linked"|"deleting"|"deleted";
  failures:number; attempts:Record<string,Attempt>; current:VisitDocument["current"];
  visitId?:string;
};
export function documentRuntime() {
  const { bucket, origin, secret } = documentEnvironment();
  return { bucket:getStorage().bucket(bucket), origin, secret };
}
function fingerprint(identity:z.infer<typeof identitySchema>,secret:string) {
  return createHmac("sha256",secret).update(JSON.stringify(normalizeIdentityInput(identity))).digest("hex");
}
function requireOpen(s:Session|undefined) {
  if (!s || s.purpose || s.state !== "open" || s.expiresAt <= Date.now()) throw new HttpError(409,"Sessão da nota expirada ou já utilizada. Inicie um novo envio.");
  return s;
}
function summary(id:string,s:Session,attempt?:Attempt) {
  return { sessionId:id, failures:s.failures, canSkip:s.failures>=2, received:!!s.current,
    ...(attempt?.uploadUrl && attempt.state === "uploading" ? {uploadUrl:attempt.uploadUrl}:{}),
    ...(attempt ? {attemptId:attempt.id,attemptState:attempt.state}:{}), expiresAt:s.expiresAt };
}
export async function runDocumentCommand(input:DocumentCommand) {
  const config = documentRuntime();
  if (input.action === "open") {
    const identityHash = fingerprint(input.identity,config.secret);
    if (input.operation === "confirm") {
      if (!input.publicCode) throw new HttpError(400,"Informe o código da visita.");
      await resolvePublicCheckinVersion({...input.identity,publicCode:input.publicCode},{hmacSecret:config.secret});
    }
    const id = createHmac("sha256",config.secret).update(`document:${input.operationId}:${identityHash}:${input.operation}:${input.publicCode??""}`).digest("hex");
    const ref = adminDb.collection(collection).doc(id);
    const quota = adminDb.collection("_checkinDocumentQuotas").doc(identityHash);
    return adminDb.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (snap.exists) return summary(id,requireOpen(snap.data() as Session));
      const q = (await tx.get(quota)).data();
      const now = Date.now();
      const count = q && q.until>now ? Number(q.count) : 0;
      if (count>=10) throw new HttpError(429,"Muitas sessões de envio. Aguarde e tente novamente.");
      const s:Session = {identityHash,operation:input.operation,publicCode:input.publicCode?.trim().toUpperCase()??null,createdAt:now,expiresAt:now+DOCUMENT_SESSION_MS,state:"open",failures:0,attempts:{},current:null};
      tx.create(ref,s);
      tx.set(quota,{count:count+1,until:count?q!.until:now+DOCUMENT_SESSION_MS});
      return summary(id,s);
    });
  }
  const ref = adminDb.collection(collection).doc(input.sessionId);
  let s = requireOpen((await ref.get()).data() as Session|undefined);
  if (input.action === "begin") {
    const object = `checkin-uploads/${input.sessionId}/${input.attemptId}/original`;
    const existing = s.attempts[input.attemptId];
    if (existing?.uploadUrl) return summary(input.sessionId,s,existing);
    await adminDb.runTransaction(async tx => {
      const current = requireOpen((await tx.get(ref)).data() as Session);
      const attempt = current.attempts[input.attemptId];
      if (attempt) {
        if(attempt.name!==input.name || attempt.size!==input.size) throw new HttpError(409,"Tentativa já utilizada.");
        throw new HttpError(409,"Preparação do envio em andamento. Consulte o resultado.");
      }
      if (Object.values(current.attempts).some(a=>a.state==="uploading"||a.state==="starting")) throw new HttpError(409,"Conclua a tentativa anterior.");
      if (Object.keys(current.attempts).length>=8) throw new HttpError(429,"Limite de envios desta sessão atingido.");
      tx.create(adminDb.collection("_checkinTemporaryObjects").doc(input.attemptId),{object,sessionId:input.sessionId,createdAt:Date.now(),state:"unlinked"});
      tx.update(ref,{[`attempts.${input.attemptId}`]:{id:input.attemptId,object,name:input.name,size:input.size,state:"starting"}});
    });
    try {
      const [url] = await config.bucket.file(object).createResumableUpload({origin:config.origin, metadata:{contentLength:input.size,contentType:"application/octet-stream",cacheControl:"private, no-store",metadata:{documentSession:input.sessionId}},preconditionOpts:{ifGenerationMatch:0}});
      await adminDb.collection("_checkinTemporaryObjects").doc(input.attemptId).update({uploadUrl:url});
      await ref.update({[`attempts.${input.attemptId}.uploadUrl`]:url,[`attempts.${input.attemptId}.state`] :"uploading"});
    } catch(error) {
      // Preparing a URL is not a driver upload failure and does not unlock the exception.
      await adminDb.runTransaction(async tx=>{const current=requireOpen((await tx.get(ref)).data() as Session); const attempts={...current.attempts};delete attempts[input.attemptId];tx.update(ref,{attempts});});
      throw error;
    }
    s = requireOpen((await ref.get()).data() as Session);
    return summary(input.sessionId,s,s.attempts[input.attemptId]);
  }
  const attempt=s.attempts[input.attemptId];
  if(!attempt) throw new HttpError(404,"Tentativa não encontrada.");
  if(input.action === "status" || attempt.state==="received" || attempt.state==="failed") return summary(input.sessionId,s,attempt);
  if(attempt.state!=="uploading") throw new HttpError(409,"Preparação do envio em andamento. Consulte novamente.");
  const file=config.bucket.file(attempt.object);
  let receipt:VisitDocument["current"]=null;
  const [exists]=await file.exists();
  if(exists) {
    const [metadata]=await file.getMetadata();
    const size=Number(metadata.size);
    if(size>0 && size<=DOCUMENT_MAX_BYTES && size===attempt.size) {
      const [bytes]=await file.download({validation:"crc32c"});
      const type=detectDocumentType(bytes);
      if(type) receipt={id:attempt.id,object:attempt.object,generation:String(metadata.generation),name:attempt.name,size,contentType:type,sha256:createHash("sha256").update(bytes).digest("hex"),receivedAtIso:new Date().toISOString(),previewStatus:type==="application/pdf"?"not-applicable":"pending"};
    }
  }
  if(!receipt && input.action==="finalize" && !exists) throw new HttpError(409,"O envio ainda não foi concluído. Tente novamente.");
  // Revoke an incomplete upload before counting failure. A late completion is rechecked.
  if(!exists && attempt.uploadUrl) {
    const cancelled=await fetch(attempt.uploadUrl,{method:"DELETE",signal:AbortSignal.timeout(10000)});
    if(![200,204,404,410,499].includes(cancelled.status)) throw new HttpError(409,"Não foi possível encerrar o envio. Consulte novamente.");
    if((await file.exists())[0]) return runDocumentCommand({...input,action:"finalize"});
  }
  return adminDb.runTransaction(async tx=>{
    const current=requireOpen((await tx.get(ref)).data() as Session);
    const a=current.attempts[input.attemptId];
    if(a.state==="failed"||a.state==="received") return summary(input.sessionId,current,a);
    a.state=receipt?"received":"failed";
    // Previous selection stays stored until a new selection succeeds, but cannot be silently used.
    current.current=receipt;
    if(!receipt) current.failures++;
    tx.update(ref,{attempts:current.attempts,current:receipt,failures:current.failures});
    return summary(input.sessionId,current,a);
  });
}
/** Reads happen before confirmation writes. Linking uses the same Firestore transaction. */
export async function prepareVisitDocument(tx:FirebaseFirestore.Transaction, receipt:DocumentReceipt|undefined, identity:z.infer<typeof identitySchema>,visitId:string,publicCode:string,operation:"confirm"|"walk-in") {
  const config=documentRuntime();
  if(!receipt) throw new HttpError(422,"Anexe a nota fiscal antes de confirmar.");
  const ref=adminDb.collection(collection).doc(capability.parse(receipt.sessionId));
  const s=requireOpen((await tx.get(ref)).data() as Session);
  if(s.identityHash!==fingerprint(identity,config.secret) || s.operation!==operation || (s.publicCode && s.publicCode!==publicCode)) throw new HttpError(403,"A nota não pertence a este check-in.");
  if(Object.values(s.attempts).some(a=>a.state==="uploading"||a.state==="starting")) throw new HttpError(409,"Aguarde o término do envio.");
  if(receipt.skip ? (s.failures<2 || !!s.current) : !s.current) throw new HttpError(422,"Envie a nota ou conclua a tentativa antes de confirmar.");
  const document:VisitDocument={status:receipt.skip?"pending":"received",sessionId:receipt.sessionId,current:receipt.skip?null:s.current};
  return {document,link:()=>{
    tx.update(ref,{state:"linked",visitId,linkedAtIso:new Date().toISOString()});
    if(document.current) tx.update(adminDb.collection("_checkinTemporaryObjects").doc(document.current.id),{state:"linked",visitId});
    if(document.current?.previewStatus==="pending") tx.set(adminDb.collection("_checkinPreviewJobs").doc(document.current.id),{visitId,documentId:document.current.id,object:document.current.object,generation:document.current.generation,state:"pending",createdAt:Date.now(),attempts:0});
  }};
}

export async function documentConfirmedReplay(receipt:DocumentReceipt,identity:z.infer<typeof identitySchema>) {
  const {secret}=documentRuntime();
  const s=(await adminDb.collection(collection).doc(capability.parse(receipt.sessionId)).get()).data() as Session|undefined;
  if(!s || s.identityHash!==fingerprint(identity,secret) || s.operation!=="walk-in") throw new HttpError(403,"Sessão documental inválida.");
  if(s.state!=="linked" || !s.visitId) return null;
  const stored=(await adminDb.collection("checkins").doc(s.visitId).get()).data();
  if(!stored?.confirmedAtIso) throw new HttpError(409,"Registro documental inconsistente.");
  return {publicCode:String(stored.publicCode),version:Number(stored.version),publicStatus:"confirmed" as const};
}
