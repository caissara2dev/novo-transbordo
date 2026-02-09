import { NextRequest } from "next/server";
import { ensureApproved, ensureRole, requireAuth } from "@/lib/server/auth";
import { restoreEvent } from "@/lib/server/events";
import { fail, ok } from "@/lib/server/http";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const { profile, uid, email } = await requireAuth(req);

    ensureApproved(profile);
    ensureRole(profile, ["ADMIN"]);

    const result = await restoreEvent(id, { uid, email });

    return ok(result);
  } catch (error) {
    return fail(error);
  }
}
