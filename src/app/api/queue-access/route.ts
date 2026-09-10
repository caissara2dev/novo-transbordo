import { NextRequest } from "next/server";
import { z } from "zod";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { requireAuth, ensureApproved, ensureRole } from "@/lib/server/auth";
import { HttpError } from "@/lib/domain/errors";
import { ok, fail, parseJsonBody } from "@/lib/server/http";
const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[^/]+$/);
const schema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("CLIENT"),
      clientId: identifier,
      portalEnabled: z.boolean(),
      usesSample: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("USER"),
      uid: identifier,
      role: z.enum(["ANALYST", "CUSTOMER"]),
      clientId: identifier.nullable(),
    })
    .strict(),
]);
export async function GET(req: NextRequest) {
  try {
    const { profile } = await requireAuth(req);
    ensureApproved(profile);
    ensureRole(profile, ["ADMIN"]);
    const [clients, users] = await Promise.all([
      adminDb.collection("clients").where("active", "==", true).get(),
      adminDb.collection("users").get(),
    ]);
    return ok(
      {
        clients: clients.docs.map((d) => ({
          id: d.id,
          name: d.data().name,
          portalEnabled: d.data().portalEnabled === true,
          usesSample: d.data().usesSample !== false,
        })),
        users: users.docs.map((d) => ({
          id: d.id,
          email: d.data().email,
          role: d.data().role,
          clientId: d.data().clientId ?? null,
          approved: d.data().approved,
        })),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return fail(e);
  }
}
export async function POST(req: NextRequest) {
  try {
    const { profile, uid } = await requireAuth(req);
    ensureApproved(profile);
    ensureRole(profile, ["ADMIN"]);
    const command = await parseJsonBody(req, schema);
    await adminDb.runTransaction(async (tx) => {
      const ref =
        command.kind === "CLIENT"
          ? adminDb.collection("clients").doc(command.clientId)
          : adminDb.collection("users").doc(command.uid);
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpError(404, "Cadastro não encontrado.");
      if (command.kind === "USER" && command.uid === uid)
        throw new HttpError(
          409,
          "Use outra conta para preservar seu acesso de administrador.",
        );
      if (command.kind === "USER" && command.role === "CUSTOMER") {
        if (!command.clientId)
          throw new HttpError(400, "Selecione o cliente da conta.");
        const client = await tx.get(
          adminDb.collection("clients").doc(command.clientId),
        );
        if (
          !client.exists ||
          !client.data()?.active ||
          !client.data()?.portalEnabled
        )
          throw new HttpError(
            400,
            "Habilite o portal para um cliente ativo antes de conceder acesso.",
          );
      }
      const patch =
        command.kind === "CLIENT"
          ? {
              portalEnabled: command.portalEnabled,
              usesSample: command.usesSample,
            }
          : {
              role: command.role,
              clientId: command.role === "CUSTOMER" ? command.clientId : null,
              approved: true,
              approvedByUid: uid,
              approvedAt: FieldValue.serverTimestamp(),
            };
      tx.update(ref, {
        ...patch,
        updatedAt: FieldValue.serverTimestamp(),
        updatedByUid: uid,
      });
      tx.create(adminDb.collection("_queueAccessAudit").doc(), {
        target: ref.path,
        actorUid: uid,
        command,
        createdAt: FieldValue.serverTimestamp(),
      });
    });
    return ok({ saved: true });
  } catch (e) {
    return fail(e);
  }
}
