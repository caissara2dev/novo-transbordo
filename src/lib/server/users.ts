import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { HttpError } from "@/lib/domain/errors";
import { UserRole } from "@/types/domain";

export async function ensureUserProfile(payload: {
  uid: string;
  email: string;
  name: string | null;
}) {
  const ref = adminDb.collection("users").doc(payload.uid);
  const snap = await ref.get();

  if (!snap.exists) {
    await ref.set({
      email: payload.email,
      name: payload.name,
      role: "OPERATOR",
      approved: false,
      active: true,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      approvedAt: null,
      approvedByUid: null,
      approvedByEmail: null
    });

    return;
  }

  await ref.update({
    email: payload.email,
    name: payload.name,
    updatedAt: FieldValue.serverTimestamp()
  });
}

export async function listUsers() {
  const snap = await adminDb.collection("users").orderBy("createdAt", "desc").limit(200).get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

export async function setApproval(params: {
  targetUid: string;
  approved: boolean;
  actorUid: string;
  actorEmail: string;
}) {
  const ref = adminDb.collection("users").doc(params.targetUid);
  const snap = await ref.get();

  if (!snap.exists) {
    throw new HttpError(404, "Usuario nao encontrado.");
  }

  await ref.update({
    approved: params.approved,
    approvedAt: params.approved ? FieldValue.serverTimestamp() : null,
    approvedByUid: params.approved ? params.actorUid : null,
    approvedByEmail: params.approved ? params.actorEmail : null,
    updatedAt: FieldValue.serverTimestamp()
  });

  const updated = await ref.get();
  return { id: updated.id, ...updated.data() };
}

export async function setRole(params: {
  targetUid: string;
  role: UserRole;
  actorUid: string;
}) {
  const ref = adminDb.collection("users").doc(params.targetUid);
  const snap = await ref.get();

  if (!snap.exists) {
    throw new HttpError(404, "Usuario nao encontrado.");
  }

  await ref.update({
    role: params.role,
    updatedAt: FieldValue.serverTimestamp(),
    updatedByUid: params.actorUid
  });

  const updated = await ref.get();
  return { id: updated.id, ...updated.data() };
}
