import { NextRequest } from "next/server";
import { z } from "zod";
import { ensureApproved, ensureRole, requireAuth } from "@/lib/server/auth";
import { fail, ok, parseJsonBody } from "@/lib/server/http";
import { toPlain } from "@/lib/server/serialize";
import { setRole } from "@/lib/server/users";

const roleBodySchema = z
  .object({
    role: z.enum(["OPERATOR", "SUPERVISOR", "DISPLAY", "ADMIN"])
  })
  .strict();

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ uid: string }> }
) {
  try {
    const { uid: targetUid } = await context.params;
    const { profile, uid } = await requireAuth(req);

    ensureApproved(profile);
    ensureRole(profile, ["ADMIN"]);

    const body = await parseJsonBody(req, roleBodySchema);

    const updated = await setRole({
      targetUid,
      role: body.role,
      actorUid: uid
    });

    return ok({ item: toPlain(updated) });
  } catch (error) {
    return fail(error);
  }
}
