import "server-only";
import { z } from "zod";
import { adminDb } from "@/lib/firebase/admin";
import { HttpError } from "@/lib/domain/errors";
import type { DocumentHistoryPage, DocumentVersion } from "@/lib/domain/checkin-document";
import type { QueueActor } from "./queue-service";
import { assertQueueActor } from "./queue-service";
import { documentRuntime } from "./documents";
import type { UserDoc } from "@/types/domain";
import type { StoredCheckin } from "@/types/checkins";

function assertInternal(actor: QueueActor) {
  assertQueueActor(actor);
  if (!["ADMIN", "SUPERVISOR", "ANALYST"].includes(actor.profile.role))
    throw new HttpError(403, "Documento disponível somente para a Line.");
}
async function confirmedVisit(actor: QueueActor, id: string) {
  assertInternal(actor);
  if (!z.string().uuid().safeParse(id).success) throw new HttpError(404, "Visita não encontrada.");
  const profile = (await adminDb.collection("users").doc(actor.uid).get()).data() as UserDoc | undefined;
  if (!profile) throw new HttpError(403, "Perfil indisponível.");
  assertInternal({ uid: actor.uid, profile });
  const visit = (await adminDb.collection("checkins").doc(id).get()).data() as StoredCheckin | undefined;
  if (!visit?.confirmedAtIso) throw new HttpError(404, "Visita não encontrada.");
  return {visit, profile};
}

/** Only textual metadata crosses this boundary; storage paths/capabilities stay internal. */
export async function listDocumentVersions(actor: QueueActor, id: string, cursor?: string): Promise<DocumentHistoryPage> {
  await confirmedVisit(actor, id);
  let query = adminDb.collection("_checkinDocumentVersions").where("visitId", "==", id).orderBy("replacedAtIso", "desc");
  if (cursor) {
    if (!z.string().uuid().safeParse(cursor).success) throw new HttpError(400, "Cursor inválido.");
    const last = await adminDb.collection("_checkinDocumentVersions").doc(cursor).get();
    if (!last.exists || last.data()?.visitId !== id) throw new HttpError(400, "Cursor inválido.");
    query = query.startAfter(last);
  }
  const rows = await query.limit(21).get();
  const page = rows.docs.slice(0, 20);
  const now = Date.now();
  return {
    items: page.map(row => {
      const value = row.data() as DocumentVersion;
      return {
        id: row.id, name: value.document.name, size: value.document.size, contentType: value.document.contentType,
        replacedAtIso: value.replacedAtIso, expiresAtIso: new Date(value.expiresAt).toISOString(),
        replacedBy: value.replacedBy, state: value.state,
        available: value.state === "available" && value.expiresAt > now,
      };
    }),
    nextCursor: rows.size > 20 ? page.at(-1)!.id : null,
  };
}

export async function getDocumentDownload(actor: QueueActor, id: string, preview = false, versionId?: string) {
  const {visit, profile} = await confirmedVisit(actor, id);
  let current = visit.document?.current;
  let expires = Date.now() + 60_000;
  if (versionId) {
    if (!z.string().uuid().safeParse(versionId).success) throw new HttpError(404, "Versão da nota não encontrada.");
    const archived = (await adminDb.collection("_checkinDocumentVersions").doc(versionId).get()).data() as DocumentVersion | undefined;
    if (!archived || archived.visitId !== id || archived.document.id !== versionId)
      throw new HttpError(404, "Versão da nota não encontrada.");
    if (archived.state !== "available" || archived.expiresAt <= Date.now())
      throw new HttpError(410, "O prazo desta versão terminou ou o arquivo foi removido. O registro da troca foi preservado.");
    current = archived.document;
    // A signed URL cannot extend the retention window, even when issued near its end.
    expires = Math.min(expires, archived.expiresAt);
  }
  if (!current) throw new HttpError(404, "Nota fiscal ainda não recebida.");
  if (preview && (!current.previewObject || current.previewStatus !== "ready"))
    throw new HttpError(409, "Prévia ainda indisponível. O original pode ser baixado.");
  const { bucket } = documentRuntime();
  const name = preview ? "nota-previa.jpg" : current.name;
  const generation = preview ? current.previewGeneration : current.generation;
  const [url] = await bucket.file(preview ? current.previewObject! : current.object).getSignedUrl({
    version: "v4", action: "read", expires,
    responseDisposition: `${preview ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
    responseType: preview ? "image/jpeg" : current.contentType,
    ...(generation ? { queryParams: { generation } } : {}),
  });
  await adminDb.collection("checkins").doc(id).collection("revisions").add({
    action: preview ? "INVOICE_PREVIEW_ACCESSED" : "INVOICE_DOWNLOAD_AUTHORIZED",
    actorUid: actor.uid, actorRole: profile.role, documentId: current.id, createdAtIso: new Date().toISOString(),
  });
  return { url, name, expiresInSeconds: Math.max(0, Math.floor((expires - Date.now()) / 1000)) };
}
