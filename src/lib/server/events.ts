import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { HttpError } from "@/lib/domain/errors";
import { collectChangedFields, validateEventInput } from "@/lib/domain/validation";
import { EventDoc, UserDoc } from "@/types/domain";

async function assertClientIfRequired(clientId: string | null): Promise<string | null> {
  if (!clientId) {
    return null;
  }

  const clientRef = adminDb.collection("clients").doc(clientId);
  const snap = await clientRef.get();

  if (!snap.exists) {
    throw new HttpError(400, "Cliente informado nao existe.");
  }

  const client = snap.data() as { active: boolean; name: string };

  if (!client.active) {
    throw new HttpError(400, "Cliente informado esta inativo.");
  }

  return client.name;
}

async function assertNoOverlap(params: {
  pump: EventDoc["pump"];
  startAt: Timestamp;
  endAt: Timestamp;
  ignoreEventId?: string;
}): Promise<void> {
  const snap = await adminDb
    .collection("events")
    .where("pump", "==", params.pump)
    .where("deleted", "==", false)
    .where("startAt", "<", params.endAt)
    .get();

  const hasOverlap = snap.docs.some((doc) => {
    if (params.ignoreEventId && doc.id === params.ignoreEventId) {
      return false;
    }

    const data = doc.data() as EventDoc;
    const existingStart = data.startAt as Timestamp;
    const existingEnd = data.endAt as Timestamp;

    return existingStart.toMillis() < params.endAt.toMillis() && existingEnd.toMillis() > params.startAt.toMillis();
  });

  if (hasOverlap) {
    throw new HttpError(409, "Existe sobreposicao de horario em lancamentos desta bomba.");
  }
}

export async function createEvent(raw: unknown, actor: { uid: string; email: string }) {
  const validated = validateEventInput(raw);
  const clientNameSnapshot = await assertClientIfRequired(validated.event.clientId);

  const startAt = Timestamp.fromDate(new Date(validated.startAtIso));
  const endAt = Timestamp.fromDate(new Date(validated.endAtIso));

  await assertNoOverlap({
    pump: validated.event.pump,
    startAt,
    endAt
  });

  const now = FieldValue.serverTimestamp();

  const payload: Omit<EventDoc, "createdAt" | "updatedAt"> & {
    createdAt: FieldValue;
    updatedAt: FieldValue;
  } = {
    ...validated.event,
    productive: validated.productive,
    clientNameSnapshot,
    startAt,
    endAt,
    durationMinutes: validated.durationMinutes,
    createdByUid: actor.uid,
    createdByEmail: actor.email,
    updatedByUid: actor.uid,
    updatedByEmail: actor.email,
    createdAt: now,
    updatedAt: now,
    deleted: false,
    deletedAt: null,
    deletedByUid: null,
    deletedByEmail: null,
    deletedReason: null
  };

  const ref = await adminDb.collection("events").add(payload);
  const created = await ref.get();

  return {
    id: ref.id,
    ...created.data(),
    warnings: validated.warnings
  };
}

export async function updateEvent(
  eventId: string,
  raw: unknown,
  actor: { uid: string; email: string; role: UserDoc["role"] }
) {
  const ref = adminDb.collection("events").doc(eventId);
  const snap = await ref.get();

  if (!snap.exists) {
    throw new HttpError(404, "Lancamento nao encontrado.");
  }

  const existing = snap.data() as EventDoc;

  if (existing.deleted) {
    throw new HttpError(400, "Nao e permitido editar lancamento excluido.");
  }

  const validated = validateEventInput(raw);
  const clientNameSnapshot = await assertClientIfRequired(validated.event.clientId);

  const startAt = Timestamp.fromDate(new Date(validated.startAtIso));
  const endAt = Timestamp.fromDate(new Date(validated.endAtIso));

  await assertNoOverlap({
    pump: validated.event.pump,
    startAt,
    endAt,
    ignoreEventId: eventId
  });

  const updatedPayload: Partial<EventDoc> & {
    updatedAt: FieldValue;
  } = {
    ...validated.event,
    productive: validated.productive,
    clientNameSnapshot,
    startAt,
    endAt,
    durationMinutes: validated.durationMinutes,
    updatedByUid: actor.uid,
    updatedByEmail: actor.email,
    updatedAt: FieldValue.serverTimestamp()
  };

  const comparableNext = {
    ...(existing as Record<string, unknown>),
    ...validated.event,
    productive: validated.productive,
    clientNameSnapshot,
    startAt,
    endAt,
    durationMinutes: validated.durationMinutes,
    updatedByUid: actor.uid,
    updatedByEmail: actor.email
  };

  const diff = collectChangedFields(existing as Record<string, unknown>, comparableNext);

  await ref.update(updatedPayload);

  if (diff.changedFields.length) {
    await ref.collection("revisions").add({
      editedAt: FieldValue.serverTimestamp(),
      editedByUid: actor.uid,
      editedByEmail: actor.email,
      reason:
        (raw as { revisionReason?: string | null })?.revisionReason?.toString().trim() || null,
      changedFields: diff.changedFields,
      before: diff.before,
      after: diff.after
    });
  }

  const updated = await ref.get();

  return {
    id: updated.id,
    ...updated.data(),
    warnings: validated.warnings
  };
}

export async function softDeleteEvent(
  eventId: string,
  reason: string,
  actor: { uid: string; email: string }
) {
  const ref = adminDb.collection("events").doc(eventId);
  const snap = await ref.get();

  if (!snap.exists) {
    throw new HttpError(404, "Lancamento nao encontrado.");
  }

  const trimmedReason = reason.trim();

  if (!trimmedReason) {
    throw new HttpError(400, "Motivo da exclusao e obrigatorio.");
  }

  await ref.update({
    deleted: true,
    deletedAt: FieldValue.serverTimestamp(),
    deletedByUid: actor.uid,
    deletedByEmail: actor.email,
    deletedReason: trimmedReason,
    updatedByUid: actor.uid,
    updatedByEmail: actor.email,
    updatedAt: FieldValue.serverTimestamp()
  });

  return { ok: true };
}

export async function restoreEvent(eventId: string, actor: { uid: string; email: string }) {
  const ref = adminDb.collection("events").doc(eventId);
  const snap = await ref.get();

  if (!snap.exists) {
    throw new HttpError(404, "Lancamento nao encontrado.");
  }

  await ref.update({
    deleted: false,
    deletedAt: null,
    deletedByUid: null,
    deletedByEmail: null,
    deletedReason: null,
    updatedByUid: actor.uid,
    updatedByEmail: actor.email,
    updatedAt: FieldValue.serverTimestamp()
  });

  return { ok: true };
}

export async function listEvents(params: {
  role: UserDoc["role"];
  uid: string;
  filters: {
    dateFrom?: string;
    dateTo?: string;
    pump?: string;
    shiftType?: string;
    category?: string;
    clientId?: string;
    includeDeleted?: boolean;
  };
}) {
  const { role, uid, filters } = params;

  let query = adminDb.collection("events") as FirebaseFirestore.Query;

  if (role === "OPERATOR") {
    query = query.where("createdByUid", "==", uid);
  }

  if (!filters.includeDeleted) {
    query = query.where("deleted", "==", false);
  }

  if (filters.dateFrom) {
    query = query.where("shiftDate", ">=", filters.dateFrom);
  }

  if (filters.dateTo) {
    query = query.where("shiftDate", "<=", filters.dateTo);
  }

  if (filters.pump) {
    query = query.where("pump", "==", filters.pump);
  }

  if (filters.shiftType) {
    query = query.where("shiftType", "==", filters.shiftType);
  }

  if (filters.category) {
    query = query.where("category", "==", filters.category);
  }

  if (filters.clientId) {
    query = query.where("clientId", "==", filters.clientId);
  }

  const snap = await query.orderBy("createdAt", "desc").limit(200).get();

  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}
