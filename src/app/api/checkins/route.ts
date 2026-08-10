import { NextRequest } from "next/server";
import { ensureApproved, requireAuth } from "@/lib/server/auth";
import { listInternalCheckins } from "@/lib/server/checkins/internal-service";
import { fail, ok } from "@/lib/server/http";
import { toPlain } from "@/lib/server/serialize";
import { actorFromContext, parseStatuses } from "./_route-helpers";

export async function GET(request: NextRequest) {
  try {
    const context = await requireAuth(request);
    ensureApproved(context.profile);
    const statuses = parseStatuses(request.nextUrl.searchParams);
    const items = await listInternalCheckins({
      actor: actorFromContext(context),
      statuses
    });
    return ok({ items: toPlain(items) });
  } catch (error) {
    return fail(error);
  }
}
