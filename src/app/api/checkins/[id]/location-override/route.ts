import { NextRequest } from "next/server";
import { ensureApproved, ensureRole, requireAuth } from "@/lib/server/auth";
import { getInternalCheckin } from "@/lib/server/checkins/internal-service";
import {
  commitOfficialLocationOverride,
  markOfficialMutationFailure,
  reserveOfficialLocationOverride
} from "@/lib/server/checkins/official-mutation";
import { createPowerAutomateCheckinAdapterFromEnv } from "@/lib/server/checkins/power-automate-adapter";
import { fail, ok, parseJsonBody } from "@/lib/server/http";
import { toPlain } from "@/lib/server/serialize";
import {
  actorFromContext,
  assertExpectedDetailVersion,
  locationOverrideSchema,
  parseCheckinId,
  parseOfficialRecordDetail
} from "../../_route-helpers";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, routeContext: RouteContext) {
  try {
    const context = await requireAuth(request);
    ensureApproved(context.profile);
    ensureRole(context.profile, ["SUPERVISOR", "ADMIN"]);
    const checkinId = parseCheckinId((await routeContext.params).id);
    const body = await parseJsonBody(request, locationOverrideSchema);
    const actor = actorFromContext(context);
    const detail = parseOfficialRecordDetail(
      await getInternalCheckin({ actor, checkinId })
    );
    assertExpectedDetailVersion(detail, body.expectedVersion);
    const nowIso = new Date().toISOString();
    const reservation = await reserveOfficialLocationOverride({
      actor,
      checkinId,
      expectedVersion: body.expectedVersion,
      justification: body.justification,
      nowIso
    });
    try {
      const confirmation =
        await createPowerAutomateCheckinAdapterFromEnv().includeIdempotently({
          publicCode: reservation.publicCode,
          form: reservation.form,
          startedAtIso: nowIso
        });
      await commitOfficialLocationOverride({
        checkinId,
        token: reservation.token,
        confirmedAtIso: confirmation.confirmedAtIso
      });
    } catch (error) {
      await markOfficialMutationFailure({
        checkinId,
        token: reservation.token,
        failedAtIso: new Date().toISOString()
      });
      throw error;
    }
    const item = await getInternalCheckin({ actor, checkinId });
    return ok({ item: toPlain(item) });
  } catch (error) {
    return fail(error);
  }
}
