import { DecodedIdToken } from "firebase-admin/auth";
import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { HttpError } from "@/lib/domain/errors";
import { protectApiRequest } from "@/lib/server/request-protection";
import { UserDoc } from "@/types/domain";

export type RequestContext = {
  token: DecodedIdToken;
  profile: UserDoc;
  uid: string;
  email: string;
};

export function ensureDisplayApiAccess(profile: UserDoc, pathname: string): void {
  const displayAllowed =
    pathname === "/api/me" ||
    pathname.startsWith("/api/auth/") ||
    pathname === "/api/display/overview";

  if (profile.role === "DISPLAY" && !displayAllowed) {
    throw new HttpError(403, "Conta de display sem acesso à operação.");
  }
}

export async function requireVerifiedToken(req: NextRequest): Promise<DecodedIdToken> {
  const decoded = await protectApiRequest(req);

  if (decoded.email_verified !== true) {
    throw new HttpError(403, "Verifique seu e-mail antes de continuar.", {
      code: "EMAIL_UNVERIFIED"
    });
  }

  return decoded;
}

export async function requireAuth(req: NextRequest): Promise<RequestContext> {
  const decoded = await requireVerifiedToken(req);
  const uid = decoded.uid;

  const userRef = adminDb.collection("users").doc(uid);
  const userSnap = await userRef.get();

  if (!userSnap.exists) {
    throw new HttpError(404, "Perfil de usuário não encontrado.");
  }

  const profile = userSnap.data() as UserDoc;

  if (!profile.active) {
    throw new HttpError(403, "Usuário inativo.");
  }

  ensureDisplayApiAccess(profile, req.nextUrl.pathname);

  return {
    token: decoded,
    profile,
    uid,
    email: decoded.email || profile.email
  };
}

export function ensureApproved(profile: UserDoc): void {
  if (!profile.approved) {
    throw new HttpError(403, "Usuário ainda não aprovado.");
  }
}

export function ensureRole(profile: UserDoc, allowed: Array<UserDoc["role"]>): void {
  if (!allowed.includes(profile.role)) {
    throw new HttpError(403, "Permissão insuficiente.");
  }
}
