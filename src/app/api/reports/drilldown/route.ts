import { NextRequest } from "next/server";
import { ensureApproved, ensureRole, requireAuth } from "@/lib/server/auth";
import { fail, ok } from "@/lib/server/http";
import { parseDrilldownParams, parseReportsFilters } from "@/lib/server/reports-filters";
import { getReportsDrilldown } from "@/lib/server/reports";

export async function GET(req: NextRequest) {
  try {
    const { profile } = await requireAuth(req);
    ensureApproved(profile);
    ensureRole(profile, ["SUPERVISOR", "ADMIN"]);

    const filters = parseReportsFilters(req.nextUrl.searchParams, {
      allowIncludeDeleted: profile.role === "ADMIN"
    });
    const drilldown = parseDrilldownParams(req.nextUrl.searchParams);

    const report = await getReportsDrilldown({
      filters,
      source: drilldown.source,
      cursor: drilldown.cursor,
      limit: drilldown.limit
    });

    return ok(report);
  } catch (error) {
    return fail(error);
  }
}
