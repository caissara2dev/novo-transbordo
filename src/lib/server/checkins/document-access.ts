import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { HttpError } from "@/lib/domain/errors";
import type { QueueActor } from "./queue-service";
import { assertQueueActor } from "./queue-service";
import { documentRuntime } from "./documents";
import type { StoredCheckin } from "@/types/checkins";
export async function getDocumentDownload(actor:QueueActor,id:string,preview=false) {
  assertQueueActor(actor);
  if(!["ADMIN","SUPERVISOR","ANALYST"].includes(actor.profile.role)) throw new HttpError(403,"Documento disponível somente para a Line.");
  if(!/^[a-f0-9-]{36}$/i.test(id)) throw new HttpError(404,"Visita não encontrada.");
  const snap=await adminDb.collection("checkins").doc(id).get();
  const visit=snap.data() as StoredCheckin|undefined;
  const current=visit?.document?.current;
  if(!visit?.confirmedAtIso || !current) throw new HttpError(404,"Nota fiscal ainda não recebida.");
  if(preview && (!current.previewObject || current.previewStatus!=="ready")) throw new HttpError(409,"Prévia ainda indisponível. O original pode ser baixado.");
  const {bucket}=documentRuntime();
  const name=preview?"nota-previa.jpg":current.name;
  const [url]=await bucket.file(preview?current.previewObject!:current.object).getSignedUrl({version:"v4",action:"read",expires:Date.now()+60_000,responseDisposition:`${preview?"inline":"attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,responseType:preview?"image/jpeg":current.contentType,...(!preview?{queryParams:{generation:current.generation}}:{})});
  await adminDb.collection("checkins").doc(id).collection("revisions").add({action:preview?"INVOICE_PREVIEW_ACCESSED":"INVOICE_DOWNLOAD_AUTHORIZED",actorUid:actor.uid,actorRole:actor.profile.role,documentId:current.id,createdAtIso:new Date().toISOString()});
  return {url,name,expiresInSeconds:60};
}
