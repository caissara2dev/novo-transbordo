import { NextRequest } from "next/server";
import { z } from "zod";
import { adminDb } from "@/lib/firebase/admin";
import { requireAuth, ensureApproved, ensureRole } from "@/lib/server/auth";
import { ok, fail, parseJsonBody } from "@/lib/server/http";
import { setRole } from "@/lib/server/users";
import { updateClient } from "@/lib/server/clients";
import { expectedAccessVersion } from "@/lib/server/admin-access";
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
      expectedVersion: expectedAccessVersion,
    })
    .strict(),
  z
    .object({
      kind: z.literal("USER"),
      uid: identifier,
      role: z.enum(["ANALYST", "CUSTOMER"]),
      clientId: identifier.nullable(),
      expectedVersion: expectedAccessVersion,
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
          accessVersion: d.data().accessVersion ?? 0,
        })),
        users: users.docs.map((d) => ({
          id: d.id,
          email: d.data().email,
          role: d.data().role,
          clientId: d.data().clientId ?? null,
          approved: d.data().approved,
          accessVersion: d.data().accessVersion ?? 0,
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
    // Legacy endpoint delegates to the same versioned services as Users/Clients.
    // Choosing a role never grants approval implicitly.
    if (command.kind === "USER") {
      await setRole({targetUid: command.uid, role: command.role, clientId: command.clientId,
        expectedVersion: command.expectedVersion, actorUid: uid});
    } else {
      await updateClient(command.clientId, {portalEnabled: command.portalEnabled,
        usesSample: command.usesSample, expectedVersion: command.expectedVersion}, uid);
    }
    return ok({ saved: true });
  } catch (e) {
    return fail(e);
  }
}
