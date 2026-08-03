import { NextRequest } from "next/server";
import { z } from "zod";
import { ensureApproved, ensureRole, requireAuth } from "@/lib/server/auth";
import { fail, ok, parseJsonBody } from "@/lib/server/http";
import { toPlain } from "@/lib/server/serialize";
import { setApproval } from "@/lib/server/users";

const approvalBodySchema = z
  .object({
    approved: z.boolean()
  })
  .strict();

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ uid: string }> }
) {
  try {
    const { uid: targetUid } = await context.params;
    const { profile, uid, email } = await requireAuth(req);

    ensureApproved(profile);
    ensureRole(profile, ["ADMIN"]);

    const body = await parseJsonBody(req, approvalBodySchema);

    const updated = await setApproval({
      targetUid,
      approved: body.approved,
      actorUid: uid,
      actorEmail: email
    });

    return ok({ item: toPlain(updated) });
  } catch (error) {
    return fail(error);
  }
}
