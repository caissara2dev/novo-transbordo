import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { HttpError } from "@/lib/domain/errors";
import { normalizePlate } from "@/lib/domain/identifiers";
import type { EventInput } from "@/types/domain";
import type { StoredCheckin } from "@/types/checkins";
import { documentBlocksCall } from "@/lib/domain/checkin-document";
import { documentHasExpired } from "@/lib/domain/document-retention";
import type { QueueIssue } from "@/lib/domain/queue";

type EventIdentity = Pick<
  EventInput,
  "category" | "clientId" | "plate" | "checkInId"
> & { loadSourceType?: EventInput["loadSourceType"] };
export function assertCheckinCreation(event: EventIdentity) {
  const enabled =
    process.env.CHECKIN_SYSTEM_RECORD_ENABLED === "true" &&
    ["observe", "enforce"].includes(
      process.env.CHECKIN_INTEGRATION_MODE ?? "off",
    );
  if (event.checkInId && !enabled)
    throw new HttpError(409, "Vínculo de check-in não está habilitado.");
  if (
    enabled &&
    process.env.CHECKIN_INTEGRATION_MODE === "enforce" &&
    event.category === "PRODUTIVO" &&
    event.loadSourceType !== "BUFFER_CONTAINER" &&
    !event.checkInId
  )
    throw new HttpError(
      409,
      "Selecione a placa de uma visita chamada no campo de origem deste lançamento.",
    );
}
/** Read before any transaction writes; execute the returned writer with the event write. */
export async function prepareCheckinEventLink(
  tx: FirebaseFirestore.Transaction,
  eventId: string,
  event: EventIdentity,
  actorUid: string,
  action: "CREATE" | "DELETE" | "RESTORE",
  expectedVersion?: number | null,
) {
  if (!event.checkInId) return () => {};
  if (
    event.category !== "PRODUTIVO" ||
    event.loadSourceType === "BUFFER_CONTAINER"
  )
    throw new HttpError(
      400,
      "Somente cargas de carreta podem ser vinculadas a uma visita.",
    );
  const ref = adminDb.collection("checkins").doc(event.checkInId);
  const snap = await tx.get(ref);
  const stored = snap.data() as
    | (StoredCheckin & { clientId?: string; issues?: QueueIssue[] })
    | undefined;
  if (!snap.exists || !stored)
    throw new HttpError(409, "Visita não encontrada.");
  if (
    stored.clientId !== event.clientId ||
    normalizePlate(stored.plate) !== normalizePlate(event.plate)
  )
    throw new HttpError(
      409,
      "Cliente e placa devem corresponder à visita selecionada.",
    );
  if (action === "DELETE") {
    if (
      stored.status !== "EM_DESCARGA" ||
      stored.activeProductiveEventId !== eventId
    )
      throw new HttpError(
        409,
        "A visita já mudou de etapa ou pertence a outro lançamento.",
      );
  } else {
    if (
      stored.status !== "CHAMADO" ||
      stored.activeProductiveEventId ||
      stored.pendingOfficialMutation ||
      stored.issues?.some((issue) => !issue.resolved) ||
      documentBlocksCall(stored.document) ||
      documentHasExpired(stored)
    )
      throw new HttpError(
        409,
        "A visita não está disponível para descarga. Atualize a seleção.",
      );
    if (action === "CREATE" && stored.version !== expectedVersion)
      throw new HttpError(
        409,
        "A visita mudou desde a seleção. Atualize e selecione novamente.",
      );
  }
  return () => {
    const now = new Date().toISOString();
    const status = action === "DELETE" ? "CHAMADO" : "EM_DESCARGA";
    tx.update(ref, {
      status,
      activeProductiveEventId: action === "DELETE" ? null : eventId,
      version: stored.version + 1,
      updatedAtIso: now,
      updatedBy: "Operação Line",
    });
    tx.create(ref.collection("revisions").doc(), {
      action: action === "DELETE" ? "Vínculo desfeito" : "Lançamento vinculado",
      actorUid,
      eventId,
      previousVersion: stored.version,
      newVersion: stored.version + 1,
      createdAtIso: now,
      changedFields: ["status", "activeProductiveEventId"],
      fromStatus: stored.status,
      toStatus: status,
    });
  };
}
