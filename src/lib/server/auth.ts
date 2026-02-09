import { DecodedIdToken } from "firebase-admin/auth";
import { NextRequest } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebase/admin";
import { HttpError } from "@/lib/domain/errors";
import { UserDoc } from "@/types/domain";

export type RequestContext = {
  token: DecodedIdToken;
  profile: UserDoc;
  uid: string;
  email: string;
};

export async function requireAuth(req: NextRequest): Promise<RequestContext> {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!token) {
    throw new HttpError(401, "Token de autenticacao ausente.");
  }

  const decoded = await adminAuth.verifyIdToken(token);
  const uid = decoded.uid;

  const userRef = adminDb.collection("users").doc(uid);
  const userSnap = await userRef.get();

  if (!userSnap.exists) {
    throw new HttpError(404, "Perfil de usuario nao encontrado.");
  }

  const profile = userSnap.data() as UserDoc;

  if (!profile.active) {
    throw new HttpError(403, "Usuario inativo.");
  }

  return {
    token: decoded,
    profile,
    uid,
    email: decoded.email || profile.email
  };
}

export function ensureApproved(profile: UserDoc): void {
  if (!profile.approved) {
    throw new HttpError(403, "Usuario ainda nao aprovado.");
  }
}

export function ensureRole(profile: UserDoc, allowed: Array<UserDoc["role"]>): void {
  if (!allowed.includes(profile.role)) {
    throw new HttpError(403, "Permissao insuficiente.");
  }
}
