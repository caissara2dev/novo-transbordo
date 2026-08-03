import { NextRequest } from "next/server";
import { ensureApproved, ensureRole, requireAuth } from "@/lib/server/auth";
import { restoreEventBodySchema } from "@/lib/server/event-request-schemas";
import { previewEventRestore, restoreEvent } from "@/lib/server/events";
import { fail, ok, parseJsonBody } from "@/lib/server/http";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const { profile } = await requireAuth(req);

    ensureApproved(profile);
    ensureRole(profile, ["ADMIN"]);

    return ok(await previewEventRestore(id));
  } catch (error) {
    return fail(error);
  }
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const { profile, uid, email } = await requireAuth(req);

    ensureApproved(profile);
    ensureRole(profile, ["ADMIN"]);

    const body = await parseJsonBody(req, restoreEventBodySchema);
    const result = await restoreEvent(id, { uid, email }, body);

    return ok(result);
  } catch (error) {
    return fail(error);
  }
}
