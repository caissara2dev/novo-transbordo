import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { HttpError } from "@/lib/domain/errors";

export async function listClients(includeInactive: boolean) {
  let query = adminDb.collection("clients") as FirebaseFirestore.Query;

  if (!includeInactive) {
    query = query.where("active", "==", true);
  }

  const snap = await query.orderBy("nameUpper", "asc").get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

export async function createClient(name: string, actorUid: string) {
  const trimmed = name.trim();

  if (!trimmed) {
    throw new HttpError(400, "Nome do cliente e obrigatorio.");
  }

  const nameUpper = trimmed.toUpperCase();

  const duplicated = await adminDb
    .collection("clients")
    .where("nameUpper", "==", nameUpper)
    .limit(1)
    .get();

  if (!duplicated.empty) {
    throw new HttpError(409, "Cliente ja cadastrado.");
  }

  const ref = await adminDb.collection("clients").add({
    name: trimmed,
    nameUpper,
    active: true,
    createdAt: FieldValue.serverTimestamp(),
    createdByUid: actorUid,
    updatedAt: FieldValue.serverTimestamp(),
    updatedByUid: actorUid
  });

  const snap = await ref.get();
  return { id: snap.id, ...snap.data() };
}

export async function updateClient(
  clientId: string,
  payload: { name?: string; active?: boolean },
  actorUid: string
) {
  const ref = adminDb.collection("clients").doc(clientId);
  const snap = await ref.get();

  if (!snap.exists) {
    throw new HttpError(404, "Cliente nao encontrado.");
  }

  const updates: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
    updatedByUid: actorUid
  };

  if (typeof payload.name === "string") {
    const trimmed = payload.name.trim();
    if (!trimmed) {
      throw new HttpError(400, "Nome do cliente invalido.");
    }

    updates.name = trimmed;
    updates.nameUpper = trimmed.toUpperCase();
  }

  if (typeof payload.active === "boolean") {
    updates.active = payload.active;
  }

  await ref.update(updates);

  const updated = await ref.get();
  return { id: updated.id, ...updated.data() };
}
