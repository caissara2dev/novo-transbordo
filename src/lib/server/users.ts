import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { HttpError } from "@/lib/domain/errors";
import { UserRole } from "@/types/domain";
import { accessIdentifier, auditAccess, readAdminProfile, requireAccessVersion, requireCustomerClient, userRoleSchema } from "./admin-access";

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
      accessVersion: 0,
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
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data(), accessVersion: doc.data().accessVersion ?? 0 }));
}

export async function setApproval(params: {
  targetUid: string;
  approved: boolean;
  actorUid: string;
  actorEmail: string;
  expectedVersion?: number;
}) {
  const ref = adminDb.collection("users").doc(accessIdentifier.parse(params.targetUid));
  await adminDb.runTransaction(async transaction => {
    const actor = await readAdminProfile(transaction, params.actorUid);
    const snap = await transaction.get(ref);
    if (!snap.exists) throw new HttpError(404, "Usuário não encontrado.");
    const existing = snap.data()!;
    const version = requireAccessVersion(existing.accessVersion, params.expectedVersion);
    if (params.targetUid === params.actorUid && !params.approved)
      throw new HttpError(409, "Use outra conta de administrador para revogar seu próprio acesso.");
    if (params.approved && existing.role === "CUSTOMER")
      await requireCustomerClient(transaction, existing.clientId);
    transaction.update(ref, {
      approved: params.approved,
      approvedAt: params.approved ? FieldValue.serverTimestamp() : null,
      approvedByUid: params.approved ? params.actorUid : null,
      approvedByEmail: params.approved ? actor.email : null,
      updatedAt: FieldValue.serverTimestamp(), updatedByUid: params.actorUid, accessVersion: version + 1
    });
    auditAccess(transaction, {target: ref.path, actorUid: params.actorUid, action: params.approved ? "USER_APPROVED" : "USER_APPROVAL_REVOKED",
      before: {approved: existing.approved}, after: {approved: params.approved}, previousVersion: version, newVersion: version + 1});
  });

  const updated = await ref.get();
  return { id: updated.id, ...updated.data() };
}

export async function setRole(params: {
  targetUid: string;
  role: UserRole;
  actorUid: string;
  clientId?: string | null;
  expectedVersion?: number;
}) {
  const role = userRoleSchema.parse(params.role);
  const clientId = role === "CUSTOMER" ? params.clientId ?? null : null;
  const ref = adminDb.collection("users").doc(accessIdentifier.parse(params.targetUid));
  await adminDb.runTransaction(async transaction => {
    await readAdminProfile(transaction, params.actorUid);
    const snap = await transaction.get(ref);
    if (!snap.exists) throw new HttpError(404, "Usuário não encontrado.");
    const existing = snap.data()!;
    const version = requireAccessVersion(existing.accessVersion, params.expectedVersion);
    if (params.targetUid === params.actorUid && role !== "ADMIN")
      throw new HttpError(409, "Use outra conta para preservar seu acesso de administrador.");
    if (role === "CUSTOMER") await requireCustomerClient(transaction, clientId);
    transaction.update(ref, {
      role, clientId, accessVersion: version + 1,
      updatedAt: FieldValue.serverTimestamp(), updatedByUid: params.actorUid
    });
    auditAccess(transaction, {target: ref.path, actorUid: params.actorUid, action: "USER_ROLE_CHANGED",
      before: {role: existing.role, clientId: existing.clientId ?? null, approved: existing.approved},
      after: {role, clientId, approved: existing.approved}, previousVersion: version, newVersion: version + 1});
  });

  const updated = await ref.get();
  return { id: updated.id, ...updated.data() };
}
