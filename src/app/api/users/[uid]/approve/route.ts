import { NextRequest } from "next/server";
import { ensureApproved, ensureRole, requireAuth } from "@/lib/server/auth";
import { fail, ok } from "@/lib/server/http";
import { toPlain } from "@/lib/server/serialize";
import { setApproval } from "@/lib/server/users";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ uid: string }> }
) {
  try {
    const { uid: targetUid } = await context.params;
    const { profile, uid, email } = await requireAuth(req);

    ensureApproved(profile);
    ensureRole(profile, ["ADMIN"]);

    const body = (await req.json()) as { approved: boolean };
    const updated = await setApproval({
      targetUid,
      approved: Boolean(body.approved),
      actorUid: uid,
      actorEmail: email
    });

    return ok({ item: toPlain(updated) });
  } catch (error) {
    return fail(error);
  }
}
