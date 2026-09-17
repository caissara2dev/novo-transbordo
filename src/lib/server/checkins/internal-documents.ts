import "server-only";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import { adminDb } from "@/lib/firebase/admin";
import { HttpError } from "@/lib/domain/errors";
import { detectDocumentType, DOCUMENT_MAX_BYTES, DOCUMENT_SESSION_MS, DOCUMENT_REPLACED_RETENTION_MS, type DocumentVersion, type VisitDocument } from "@/lib/domain/checkin-document";
import type { StoredCheckin } from "@/types/checkins";
import type { UserDoc } from "@/types/domain";
import { documentRuntime } from "./documents";
import { assertQueueActor, getQueueVisit, type QueueActor } from "./queue-service";

const sessions = "_checkinDocumentSessions";
const purpose = "line-attachment";
const capability = z.string().regex(/^[a-f0-9]{64}$/);
export const internalDocumentCommandSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("begin"), operationId: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
    replaceDocumentId: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(200).refine(value => !/[\x00-\x1f\x7f/\\]/.test(value), "Nome de arquivo inválido."),
    size: z.number().int().positive().max(DOCUMENT_MAX_BYTES),
  }).strict(),
  z.object({ action: z.literal("finalize"), sessionId: capability }).strict(),
]);
type Attempt = { id: string; object: string; name: string; size: number; state: "starting" | "uploading" | "received" | "failed"; uploadUrl?: string };
type Session = {
  purpose: typeof purpose; ownerUid: string; targetVisitId: string; expectedVersion: number; replaceDocumentId?: string;
  createdAt: number; expiresAt: number; state: "open" | "linked" | "deleting" | "deleted";
  documentId: string; attempts: Record<string, Attempt>; current: VisitDocument["current"];
  visitId?: string;
};

function assertInternal(actor: QueueActor) {
  assertQueueActor(actor);
  if (!["ADMIN", "SUPERVISOR", "ANALYST"].includes(actor.profile.role))
    throw new HttpError(403, "Notas fiscais disponíveis somente para a equipe Line.");
}
async function currentProfile(tx: FirebaseFirestore.Transaction, actor: QueueActor) {
  const profile = (await tx.get(adminDb.collection("users").doc(actor.uid))).data() as UserDoc | undefined;
  if (!profile) throw new HttpError(403, "Perfil indisponível.");
  assertInternal({uid: actor.uid, profile});
  return profile;
}
function requireSession(value: Session | undefined, actor: QueueActor, visitId: string) {
  if (!value || value.purpose !== purpose || value.ownerUid !== actor.uid || value.targetVisitId !== visitId)
    throw new HttpError(404, "Envio da nota não encontrado para esta visita e usuário.");
  // A linked receipt remains replayable after expiry; it cannot authorize another upload.
  if (value.state !== "linked" && (value.state !== "open" || value.expiresAt <= Date.now()))
    throw new HttpError(410, "Envio expirado. Inicie um novo envio da nota.");
  return value;
}
function editableVisit(value: StoredCheckin | undefined, expectedVersion: number, replaceDocumentId?: string) {
  if (!value?.confirmedAtIso) throw new HttpError(404, "Visita confirmada não encontrada.");
  if (value.version !== expectedVersion || value.pendingOfficialMutation)
    throw new HttpError(409, "A visita foi alterada. Atualize e confira os dados antes de enviar a nota.");
  if (replaceDocumentId) {
    if (value.document?.status !== "received" || value.document.current?.id !== replaceDocumentId)
      throw new HttpError(409, "A nota atual mudou. Atualize e confira o documento antes de substituir.");
  } else if (value.document?.status !== "pending" || value.document.current) {
    throw new HttpError(409, "Esta visita já tem uma nota ou não possui pendência documental. Atualize a fila.");
  }
  return value;
}
function runtime() {
  const config = documentRuntime();
  const origin = process.env.CHECKIN_DOCUMENT_INTERNAL_ORIGIN;
  const stagingOrigin = "https://checkin-system-nf--line-transbordo-staging-382612.us-central1.hosted.app";
  const emulator = process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_PROJECT_ID?.startsWith("demo-");
  if (!origin || (!emulator && origin !== stagingOrigin))
    throw new HttpError(503, "Origem interna do envio documental não configurada.");
  return {...config, origin};
}

export async function runInternalDocumentCommand(actor: QueueActor, visitId: string, raw: unknown) {
  assertInternal(actor);
  const id = z.string().uuid().parse(visitId);
  const input = internalDocumentCommandSchema.parse(raw);
  const config = runtime();
  const visitRef = adminDb.collection("checkins").doc(id);

  if (input.action === "begin") {
    const sessionId = createHmac("sha256", config.secret)
      .update(JSON.stringify([purpose, actor.uid, id, input.operationId])).digest("hex");
    const sessionRef = adminDb.collection(sessions).doc(sessionId);
    const documentId = randomUUID();
    const object = `checkin-uploads/${sessionId}/${documentId}/original`;
    const reservation = await adminDb.runTransaction(async tx => {
      await currentProfile(tx, actor);
      const existing = (await tx.get(sessionRef)).data() as Session | undefined;
      if (existing) {
        const session = requireSession(existing, actor, id);
        const attempt = session.attempts[session.documentId];
        if (attempt.name !== input.name || attempt.size !== input.size || session.expectedVersion !== input.expectedVersion || session.replaceDocumentId !== input.replaceDocumentId)
          throw new HttpError(409, "Esta operação já foi usada para outro envio. Escolha novamente o arquivo.");
        if (session.state === "linked") return {session, created: false};
        editableVisit((await tx.get(visitRef)).data() as StoredCheckin | undefined, input.expectedVersion, input.replaceDocumentId);
        if (attempt.state === "failed") throw new HttpError(410, "Inicie um novo envio da nota.");
        if (!attempt.uploadUrl) {
          if (session.createdAt < Date.now() - 60_000) throw new HttpError(410, "Preparação interrompida. Inicie um novo envio.");
          throw new HttpError(409, "Envio em preparação. Tente novamente em instantes.");
        }
        return {session, created: false};
      }
      editableVisit((await tx.get(visitRef)).data() as StoredCheckin | undefined, input.expectedVersion, input.replaceDocumentId);
      const quotaRef = adminDb.collection("_checkinDocumentQuotas").doc(`internal_${createHash("sha256").update(actor.uid).digest("hex")}`);
      const quota = (await tx.get(quotaRef)).data();
      const now = Date.now();
      const count = quota && quota.until > now ? Number(quota.count) : 0;
      if (count >= 60) throw new HttpError(429, "Limite de novos envios atingido. Aguarde e tente novamente.");
      const session: Session = {
        purpose, ownerUid: actor.uid, targetVisitId: id, expectedVersion: input.expectedVersion,
        ...(input.replaceDocumentId ? {replaceDocumentId: input.replaceDocumentId} : {}),
        createdAt: now, expiresAt: now + DOCUMENT_SESSION_MS, state: "open", documentId,
        attempts: {[documentId]: {id: documentId, object, name: input.name, size: input.size, state: "starting"}}, current: null,
      };
      tx.create(sessionRef, session);
      tx.create(adminDb.collection("_checkinTemporaryObjects").doc(documentId), {object, sessionId, createdAt: now, state: "unlinked"});
      tx.set(quotaRef, {count: count + 1, until: count ? quota!.until : now + DOCUMENT_SESSION_MS});
      return {session, created: true};
    });
    if (reservation.session.state === "linked")
      return {sessionId, received: true, item: await getQueueVisit(actor, id)};
    if (!reservation.created)
      return {sessionId, received: false, uploadUrl: reservation.session.attempts[reservation.session.documentId].uploadUrl};
    try {
      const [uploadUrl] = await config.bucket.file(object).createResumableUpload({
        origin: config.origin,
        metadata: {contentLength: input.size, contentType: "application/octet-stream", cacheControl: "private, no-store", metadata: {documentSession: sessionId}},
        preconditionOpts: {ifGenerationMatch: 0},
      });
      const batch = adminDb.batch();
      batch.update(adminDb.collection("_checkinTemporaryObjects").doc(documentId), {uploadUrl});
      batch.update(sessionRef, {[`attempts.${documentId}.uploadUrl`]: uploadUrl, [`attempts.${documentId}.state`]: "uploading"});
      await batch.commit();
      return {sessionId, received: false, uploadUrl};
    } catch {
      await sessionRef.update({[`attempts.${documentId}.state`]: "failed"});
      throw new HttpError(410, "Não foi possível preparar o envio. Tente novamente com o arquivo selecionado.");
    }
  }

  const sessionRef = adminDb.collection(sessions).doc(input.sessionId);
  const session = await adminDb.runTransaction(async tx => {
    await currentProfile(tx, actor);
    const current = requireSession((await tx.get(sessionRef)).data() as Session | undefined, actor, id);
    if (current.state !== "linked") editableVisit((await tx.get(visitRef)).data() as StoredCheckin | undefined, current.expectedVersion, current.replaceDocumentId);
    return current;
  });
  if (session.state === "linked") return {sessionId: input.sessionId, received: true, item: await getQueueVisit(actor, id)};
  const attempt = session.attempts[session.documentId];
  if (attempt.state === "failed") throw new HttpError(410, "O arquivo não foi aceito. Inicie um novo envio.");
  if (attempt.state !== "uploading") throw new HttpError(409, "Envio em preparação. Tente novamente em instantes.");
  const file = config.bucket.file(attempt.object);
  if (!(await file.exists())[0]) throw new HttpError(409, "O envio ainda não foi concluído. Tente novamente.");
  const [metadata] = await file.getMetadata();
  const size = Number(metadata.size);
  let current: VisitDocument["current"] = null;
  if (size > 0 && size <= DOCUMENT_MAX_BYTES && size === attempt.size && metadata.generation) {
    // Read the immutable generation being validated, never a later object version.
    const generation = String(metadata.generation);
    const [bytes] = await config.bucket.file(attempt.object, {generation}).download({validation: "crc32c"});
    const contentType = detectDocumentType(bytes);
    // A PDF terminates at EOF; an appended payload is not an accepted document.
    const validPdf = contentType !== "application/pdf" || /%%EOF[\x09\x0a\x0c\x0d\x20]*$/.test(bytes.toString("latin1"));
    if (contentType && validPdf && bytes.length === size) current = {
      id: attempt.id, object: attempt.object, generation, name: attempt.name, size,
      contentType, sha256: createHash("sha256").update(bytes).digest("hex"),
      receivedAtIso: new Date().toISOString(), previewStatus: contentType === "application/pdf" ? "not-applicable" : "pending",
    };
  }
  if (!current) {
    await adminDb.runTransaction(async tx => {
      const latest = requireSession((await tx.get(sessionRef)).data() as Session | undefined, actor, id);
      if (latest.state === "open") tx.update(sessionRef, {[`attempts.${attempt.id}.state`]: "failed"});
    });
    throw new HttpError(422, "O arquivo não foi aceito. Escolha uma foto ou PDF válido de até 10 MB.");
  }
  const receipt = current;
  await adminDb.runTransaction(async tx => {
    const profile = await currentProfile(tx, actor);
    const latest = requireSession((await tx.get(sessionRef)).data() as Session | undefined, actor, id);
    if (latest.state === "linked") return;
    const visit = editableVisit((await tx.get(visitRef)).data() as StoredCheckin | undefined, latest.expectedVersion, latest.replaceDocumentId);
    const temporaryRef = adminDb.collection("_checkinTemporaryObjects").doc(receipt.id);
    const temporary = (await tx.get(temporaryRef)).data();
    if (latest.attempts[receipt.id]?.state !== "uploading" || temporary?.state !== "unlinked")
      throw new HttpError(409, "O envio mudou. Confira a nota antes de continuar.");
    const now = new Date().toISOString();
    const actorName = profile.name || "Equipe Line";
    const previous = latest.replaceDocumentId ? visit.document!.current! : null;
    if (previous) {
      const archived: DocumentVersion = {
        visitId: id, document: previous, state: "available", replacedAtIso: now,
        expiresAt: Date.parse(now) + DOCUMENT_REPLACED_RETENTION_MS,
        replacedBy: actorName, actorUid: actor.uid, replacementDocumentId: receipt.id,
      };
      tx.create(adminDb.collection("_checkinDocumentVersions").doc(previous.id), archived);
    }
    const document: VisitDocument = {status: "received", sessionId: input.sessionId, current: receipt};
    tx.update(visitRef, {document, version: visit.version + 1, updatedBy: actorName, updatedAtIso: now});
    tx.update(sessionRef, {state: "linked", visitId: id, current: receipt, linkedAtIso: now, [`attempts.${receipt.id}.state`]: "received"});
    tx.update(temporaryRef, {state: "linked", visitId: id});
    tx.create(visitRef.collection("revisions").doc(receipt.id), {
      action: previous ? "Nota fiscal substituída" : "Nota fiscal anexada", actor: actorName, actorUid: actor.uid, actorRole: profile.role,
      documentId: receipt.id, changedFields: previous ? [previous.name, receipt.name] : [receipt.name], createdAtIso: now,
      ...(previous ? {previousDocumentId: previous.id} : {}),
      previousVersion: visit.version, newVersion: visit.version + 1,
    });
    if (receipt.previewStatus === "pending") tx.create(adminDb.collection("_checkinPreviewJobs").doc(receipt.id), {
      visitId: id, documentId: receipt.id, object: receipt.object, generation: receipt.generation,
      state: "pending", createdAt: Date.now(), attempts: 0,
    });
  });
  return {sessionId: input.sessionId, received: true, item: await getQueueVisit(actor, id)};
}
