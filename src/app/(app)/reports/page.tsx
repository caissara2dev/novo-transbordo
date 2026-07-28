"use client";

import { RoleGuard } from "@/components/role-guard";
import { authenticatedFetch } from "@/lib/auth/api-fetch";
import { useAuthSession } from "@/lib/auth/use-auth-session";
import { ReportsDrilldown } from "./reports-drilldown";
import { ReportsFilterPanel } from "./reports-filter-panel";
import { ReportsOverviewSections } from "./reports-overview";
import { useReportsDashboard } from "./use-reports-dashboard";

async function fetchReportCsv(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Blob> {
  const response = await authenticatedFetch(input, init);

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: string | { message?: string } }
      | null;
    const message =
      typeof payload?.error === "string"
        ? payload.error
        : payload?.error?.message || "Erro ao exportar.";
    throw new Error(message);
  }

  return response.blob();
}

export default function ReportsPage() {
  const { profile } = useAuthSession();
  const dashboard = useReportsDashboard({
    profile,
    fetchCsv: fetchReportCsv
  });

  return (
    <RoleGuard allowed={["SUPERVISOR", "ADMIN"]}>
      <section className="space-y-4">
        <header className="reports-header">
          <div>
            <p className="pill">Análise operacional</p>
            <h1 className="panel-title mt-2 text-2xl">Relatórios V2</h1>
            <p className="mt-1 text-sm muted">
              Dashboard analítico com comparativo de período, drilldown e
              exportação CSV.
            </p>
          </div>
          <div className="reports-export-actions">
            <button
              className="btn-soft"
              disabled={dashboard.exportingMode !== null}
              onClick={() => dashboard.exportCsv("detailed")}
              type="button"
            >
              {dashboard.exportingMode === "detailed"
                ? "Exportando..."
                : "CSV detalhado"}
            </button>
            <button
              className="btn-primary"
              disabled={dashboard.exportingMode !== null}
              onClick={() => dashboard.exportCsv("aggregated")}
              type="button"
            >
              {dashboard.exportingMode === "aggregated"
                ? "Exportando..."
                : "CSV agregado"}
            </button>
          </div>
        </header>

        {dashboard.error ? (
          <div className="notice error">{dashboard.error}</div>
        ) : null}

        <ReportsFilterPanel {...dashboard.filters} />
        <ReportsOverviewSections {...dashboard.overview} />
        <ReportsDrilldown {...dashboard.drilldown} />
      </section>
    </RoleGuard>
  );
}
