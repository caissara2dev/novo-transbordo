import { NextRequest } from "next/server";
import { ensureApproved, ensureRole, requireAuth } from "@/lib/server/auth";
import { getDisplayOverview } from "@/lib/server/display-overview";
import { fail, ok } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const { profile } = await requireAuth(req);
    ensureApproved(profile);
    ensureRole(profile, ["DISPLAY", "ADMIN"]);

    const overview = await getDisplayOverview();
    return ok(overview, {
      headers: {
        "Cache-Control": "private, no-store, max-age=0"
      }
    });
  } catch (error) {
    return fail(error);
  }
}
