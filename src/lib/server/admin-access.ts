import "server-only";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { adminDb } from "@/lib/firebase/admin";
import { HttpError } from "@/lib/domain/errors";
import type { UserDoc } from "@/types/domain";

export const accessIdentifier = z.string().min(1).max(128).regex(/^[^/]+$/);
export const expectedAccessVersion = z.number().int().nonnegative().default(0);
export const userRoleSchema = z.enum(["OPERATOR", "SUPERVISOR", "DISPLAY", "ADMIN", "ANALYST", "CUSTOMER"]);

export async function readAdminProfile(transaction: FirebaseFirestore.Transaction, uid: string) {
  const profile = (await transaction.get(adminDb.collection("users").doc(accessIdentifier.parse(uid)))).data() as UserDoc | undefined;
  if (!profile || !profile.active || !profile.approved || profile.role !== "ADMIN")
    throw new HttpError(403, "Somente administradores aprovados e ativos podem alterar acessos e clientes.");
  return profile;
}

export function requireAccessVersion(stored: unknown, expected: number | undefined): number {
  const version = typeof stored === "number" && Number.isSafeInteger(stored) && stored >= 0 ? stored : 0;
  if (version !== expectedAccessVersion.parse(expected))
    throw new HttpError(409, "Este cadastro foi alterado por outra pessoa. Atualize a lista e confira os dados antes de salvar.");
  return version;
}

export async function requireCustomerClient(transaction: FirebaseFirestore.Transaction, clientId: string | null | undefined) {
  if (!clientId) throw new HttpError(400, "Selecione o cliente da conta.");
  const client = await transaction.get(adminDb.collection("clients").doc(accessIdentifier.parse(clientId)));
  if (!client.exists || client.data()?.active !== true || client.data()?.portalEnabled !== true)
    throw new HttpError(400, "Habilite o portal para um cliente ativo antes de conceder acesso.");
}

export function auditAccess(transaction: FirebaseFirestore.Transaction, params: {
  target: string; actorUid: string; action: string; before: Record<string, unknown> | null;
  after: Record<string, unknown>; previousVersion: number; newVersion: number;
}) {
  transaction.create(adminDb.collection("_queueAccessAudit").doc(), {
    ...params, createdAt: FieldValue.serverTimestamp()
  });
}
