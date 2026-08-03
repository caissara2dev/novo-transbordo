import { NextRequest } from "next/server";
import { z } from "zod";
import { ensureApproved, ensureRole, requireAuth } from "@/lib/server/auth";
import { fail, ok, parseJsonBody } from "@/lib/server/http";
import {
  getOperationalSettings,
  updateOperationalSettings
} from "@/lib/server/operational-settings";

const operationsSettingsBodySchema = z
  .object({
    idleToleranceMinutes: z.number().int().min(0).max(60)
  })
  .strict();

export async function GET(req: NextRequest) {
  try {
    const { profile } = await requireAuth(req);
    ensureApproved(profile);
    ensureRole(profile, ["ADMIN"]);
    return ok(await getOperationalSettings());
  } catch (error) {
    return fail(error);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const { profile, uid, email } = await requireAuth(req);
    ensureApproved(profile);
    ensureRole(profile, ["ADMIN"]);
    const body = await parseJsonBody(req, operationsSettingsBodySchema);
    return ok(await updateOperationalSettings(body, { uid, email }));
  } catch (error) {
    return fail(error);
  }
}
