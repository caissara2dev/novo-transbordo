import { NextRequest } from "next/server";
import { ensureApproved, ensureRole, requireAuth } from "@/lib/server/auth";
import {
  assignInternalCheckinClient,
  correctInternalCheckin,
  getInternalCheckin
} from "@/lib/server/checkins/internal-service";
import {
  commitOfficialCorrection,
  markOfficialMutationFailure,
  reserveOfficialCorrection
} from "@/lib/server/checkins/official-mutation";
import { createPowerAutomateCheckinAdapterFromEnv } from "@/lib/server/checkins/power-automate-adapter";
import { fail, ok, parseJsonBody } from "@/lib/server/http";
import { toPlain } from "@/lib/server/serialize";
import {
  actorFromContext,
  assertExpectedDetailVersion,
  checkinMutationSchema,
  normalizedCorrectionPatch,
  parseCheckinId,
  parseOfficialRecordDetail
} from "../_route-helpers";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, routeContext: RouteContext) {
  try {
    const context = await requireAuth(request);
    ensureApproved(context.profile);
    const checkinId = parseCheckinId((await routeContext.params).id);
    const item = await getInternalCheckin({
      actor: actorFromContext(context),
      checkinId
    });
    return ok({ item: toPlain(item) });
  } catch (error) {
    return fail(error);
  }
}

export async function PATCH(request: NextRequest, routeContext: RouteContext) {
  try {
    const context = await requireAuth(request);
    ensureApproved(context.profile);
    ensureRole(context.profile, ["SUPERVISOR", "ADMIN"]);
    const checkinId = parseCheckinId((await routeContext.params).id);
    const body = await parseJsonBody(request, checkinMutationSchema);
    const actor = actorFromContext(context);
    const nowIso = new Date().toISOString();

    if (body.action === "ASSIGN_CLIENT") {
      const item = await assignInternalCheckinClient({
        actor,
        checkinId,
        clientId: body.clientId,
        expectedVersion: body.expectedVersion,
        reason: body.reason,
        nowIso
      });
      return ok({ item: toPlain(item) });
    }

    const detail = parseOfficialRecordDetail(
      await getInternalCheckin({ actor, checkinId })
    );
    assertExpectedDetailVersion(detail, body.expectedVersion);
    const patch = normalizedCorrectionPatch(detail, body.patch);
    if (detail.status === "PRE_CADASTRO") {
      const item = await correctInternalCheckin({
        actor,
        checkinId,
        patch,
        expectedVersion: body.expectedVersion,
        reason: body.reason,
        nowIso
      });
      return ok({ item: toPlain(item) });
    }

    // Reserve the exact patch before touching the official Excel row. This
    // serializes concurrent managers and makes a lost response safely retryable.
    const reservation = await reserveOfficialCorrection({
      actor,
      checkinId,
      patch,
      expectedVersion: body.expectedVersion,
      reason: body.reason,
      nowIso
    });
    try {
      const confirmation =
        await createPowerAutomateCheckinAdapterFromEnv().updateIdempotently({
          publicCode: reservation.publicCode,
          idempotencyKey: reservation.idempotencyKey,
          requestedAtIso: nowIso,
          patch: reservation.patch
        });
      await commitOfficialCorrection({
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
