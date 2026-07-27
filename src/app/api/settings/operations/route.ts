import { NextRequest } from "next/server";
import { ensureApproved, ensureRole, requireAuth } from "@/lib/server/auth";
import { fail, ok } from "@/lib/server/http";
import {
  getOperationalSettings,
  updateOperationalSettings
} from "@/lib/server/operational-settings";

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
    return ok(await updateOperationalSettings(await req.json(), { uid, email }));
  } catch (error) {
    return fail(error);
  }
}
