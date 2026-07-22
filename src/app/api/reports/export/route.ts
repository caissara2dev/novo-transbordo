import { NextRequest, NextResponse } from "next/server";
import { ensureApproved, ensureRole, requireAuth } from "@/lib/server/auth";
import { fail } from "@/lib/server/http";
import { exportReportsCsv } from "@/lib/server/reports";
import { parseExportMode, parseReportsFilters } from "@/lib/server/reports-filters";

export async function GET(req: NextRequest) {
  try {
    const { profile } = await requireAuth(req);
    ensureApproved(profile);
    ensureRole(profile, ["SUPERVISOR", "ADMIN"]);

    const filters = parseReportsFilters(req.nextUrl.searchParams, {
      allowIncludeDeleted: profile.role === "ADMIN"
    });
    const mode = parseExportMode(req.nextUrl.searchParams);

    const csv = await exportReportsCsv({ filters, mode });
    const suffix = `${filters.dateFrom}_a_${filters.dateTo}`;
    const fileName =
      mode === "aggregated"
        ? `controle-transbordo_resumo_${suffix}.csv`
        : `controle-transbordo_detalhado_${suffix}.csv`;

    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename=\"${fileName}\"`,
        "Cache-Control": "no-store"
      }
    });
  } catch (error) {
    return fail(error);
  }
}
