import { NextRequest } from "next/server";
import { ensureApproved, ensureRole, requireAuth } from "@/lib/server/auth";
import { transitionInternalCheckin } from "@/lib/server/checkins/internal-service";
import { fail, ok, parseJsonBody } from "@/lib/server/http";
import { toPlain } from "@/lib/server/serialize";
import {
  actorFromContext,
  parseCheckinId,
  transitionSchema
} from "../../_route-helpers";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, routeContext: RouteContext) {
  try {
    const context = await requireAuth(request);
    ensureApproved(context.profile);
    ensureRole(context.profile, ["SUPERVISOR", "ADMIN"]);
    const checkinId = parseCheckinId((await routeContext.params).id);
    const body = await parseJsonBody(request, transitionSchema);
    const item = await transitionInternalCheckin({
      actor: actorFromContext(context),
      checkinId,
      toStatus: body.toStatus,
      expectedVersion: body.expectedVersion,
      reason: body.reason,
      nowIso: new Date().toISOString()
    });
    return ok({ item: toPlain(item) });
  } catch (error) {
    return fail(error);
  }
}
