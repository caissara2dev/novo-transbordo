import { NextRequest } from "next/server";
import { ensureApproved, ensureRole, requireAuth } from "@/lib/server/auth";
import { HttpError } from "@/lib/domain/errors";
import { fail, ok } from "@/lib/server/http";
import { toPlain } from "@/lib/server/serialize";
import { setRole } from "@/lib/server/users";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ uid: string }> }
) {
  try {
    const { uid: targetUid } = await context.params;
    const { profile, uid } = await requireAuth(req);

    ensureApproved(profile);
    ensureRole(profile, ["ADMIN"]);

    const body = (await req.json()) as { role: string };
    if (!["OPERATOR", "SUPERVISOR", "ADMIN"].includes(body.role)) {
      throw new HttpError(400, "Role inválido.");
    }

    const updated = await setRole({
      targetUid,
      role: body.role as "OPERATOR" | "SUPERVISOR" | "ADMIN",
      actorUid: uid
    });

    return ok({ item: toPlain(updated) });
  } catch (error) {
    return fail(error);
  }
}
