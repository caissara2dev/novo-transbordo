import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { adminDb } from "@/lib/firebase/admin";
import { HttpError } from "@/lib/domain/errors";
import type { DocumentVersion } from "@/lib/domain/checkin-document";
import type { StoredCheckin } from "@/types/checkins";
import type { UserDoc } from "@/types/domain";
import { assertQueueActor, getQueueVisit, type QueueActor } from "./queue-service";

export const documentDeletionSchema = z.object({
  action: z.literal("delete"), operationId: z.string().uuid(), documentId: z.string().uuid(),
  expectedVersion: z.number().int().positive(), reason: z.string().trim().min(1, "Informe o motivo para excluir a NF.").max(300),
}).strict();

function assertDeletionActor(actor: QueueActor) {
  assertQueueActor(actor);
  if (!["ADMIN", "SUPERVISOR"].includes(actor.profile.role))
    throw new HttpError(403, "Somente administrador ou supervisor pode excluir uma nota fiscal.");
}

/** Accepts an exact-document deletion. Storage is removed asynchronously, never by a UI request. */
export async function requestDocumentDeletion(actor: QueueActor, visitId: string, raw: unknown) {
  assertDeletionActor(actor);
  const id = z.string().uuid().parse(visitId);
  const input = documentDeletionSchema.parse(raw);
  const ref = adminDb.collection("checkins").doc(id);
  const operationKey = createHash("sha256").update(JSON.stringify([actor.uid, id, input.operationId])).digest("hex");
  const operationRef = adminDb.collection("_checkinDocumentDeletions").doc(operationKey);
  const fingerprint = createHash("sha256").update(JSON.stringify([input.documentId, input.expectedVersion, input.reason])).digest("hex");
  await adminDb.runTransaction(async tx => {
    const profile = (await tx.get(adminDb.collection("users").doc(actor.uid))).data() as UserDoc | undefined;
    if (!profile) throw new HttpError(403, "Perfil indisponível.");
    assertDeletionActor({ uid: actor.uid, profile });
    const operation = (await tx.get(operationRef)).data();
    if (operation) {
      if (operation.fingerprint !== fingerprint) throw new HttpError(409, "Esta operação já foi usada para outra exclusão.");
      return;
    }
    const visit = (await tx.get(ref)).data() as StoredCheckin | undefined;
    if (!visit?.confirmedAtIso) throw new HttpError(404, "Visita não encontrada.");
    if (visit.version !== input.expectedVersion || visit.pendingOfficialMutation)
      throw new HttpError(409, "A visita mudou. Atualize e confira o documento antes de excluir.");
    const versionRef = adminDb.collection("_checkinDocumentVersions").doc(input.documentId);
    const archived = (await tx.get(versionRef)).data() as DocumentVersion | undefined;
    const isCurrent = visit.document?.current?.id === input.documentId;
    if (isCurrent && archived) throw new HttpError(409, "O documento mudou. Atualize antes de excluir.");
    if (!isCurrent && (!archived || archived.visitId !== id || archived.document.id !== input.documentId))
      throw new HttpError(404, "Documento não encontrado nesta visita.");
    if (!isCurrent && archived!.state !== "available")
      throw new HttpError(409, "Este documento já está indisponível ou em exclusão.");
    const now = new Date().toISOString();
    const actorName = profile.name || "Equipe Line";
    const deletion: NonNullable<DocumentVersion["deletion"]> = {
      operationId: input.operationId, requestedAtIso: now, actorUid: actor.uid, actorRole: profile.role,
      actorName, reason: input.reason, source: "manual",
    };
    const document = isCurrent ? visit.document!.current! : archived!.document;
    if (isCurrent) {
      const version: DocumentVersion = {
        visitId: id, document, kind: "manual-deletion", state: "deletion-requested", deletion,
        replacedAtIso: now, expiresAt: Date.parse(now), replacedBy: actorName,
        actorUid: actor.uid, replacementDocumentId: null,
      };
      tx.create(versionRef, version);
    } else tx.update(versionRef, { state: "deletion-requested", deletion });
    tx.update(ref, {
      version: visit.version + 1, updatedAtIso: now, updatedBy: actorName,
      ...(isCurrent ? { document: { ...visit.document!, status: "pending", current: null } } : {}),
    });
    tx.create(ref.collection("revisions").doc(`document-delete-request-${operationKey}`), {
      action: "Exclusão de nota solicitada", actor: actorName, actorUid: actor.uid, actorRole: profile.role,
      documentId: document.id, documentName: document.name, reason: input.reason,
      changedFields: [document.name, `Motivo: ${input.reason}`], createdAtIso: now,
      previousVersion: visit.version, newVersion: visit.version + 1,
    });
    tx.create(operationRef, { visitId: id, documentId: document.id, actorUid: actor.uid, fingerprint, createdAtIso: now });
  });
  return { item: await getQueueVisit(actor, id), deletionRequested: true };
}
