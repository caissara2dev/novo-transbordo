import { NextRequest } from "next/server";
import { ensureApproved, ensureRole, requireAuth } from "@/lib/server/auth";
import { parseReportsFilters } from "@/lib/server/reports-filters";
import { getReportsOverview } from "@/lib/server/reports";
import { fail, ok } from "@/lib/server/http";

export async function GET(req: NextRequest) {
  try {
    const { profile } = await requireAuth(req);
    ensureApproved(profile);
    ensureRole(profile, ["SUPERVISOR", "ADMIN"]);

    const filters = parseReportsFilters(req.nextUrl.searchParams, {
      allowIncludeDeleted: profile.role === "ADMIN"
    });

    const report = await getReportsOverview(filters);
    return ok(report);
  } catch (error) {
    return fail(error);
  }
}
