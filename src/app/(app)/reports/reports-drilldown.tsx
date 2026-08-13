import {
  categoryLabelMap,
  containerStatusLabelMap
} from "@/lib/domain/options";
import {
  formatDateTime,
  formatMinutes,
  numberFmt
} from "./report-formatters";
import { ReportsDashboard } from "./use-reports-dashboard";

type ReportsDrilldownProps = ReportsDashboard["drilldown"];

export function ReportsDrilldown({
  source,
  rows,
  total,
  nextCursor,
  loading,
  refresh,
  loadMore
}: ReportsDrilldownProps) {
  return (
    <section className="panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="reports-chart-title">
          Detalhamento ({source === "kpi" ? "KPI" : "Gráfico"}) -{" "}
          {numberFmt.format(total)} linhas
        </h2>
        <button
          className="btn-soft"
          disabled={loading}
          onClick={refresh}
          type="button"
        >
          Atualizar tabela
        </button>
      </div>

      <div className="reports-table-wrap mt-3">
        <table className="reports-table">
          <thead>
            <tr>
              <th>Data</th>
              <th>Turno</th>
              <th>Bomba</th>
              <th>Categoria</th>
              <th>Horário</th>
              <th>Duração</th>
              <th>Cliente</th>
              <th>Origem da carga</th>
              <th>Container</th>
              <th>Estado</th>
              <th>Motivo</th>
              <th>Criado por</th>
              <th>Editado em</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.shiftDate}</td>
                <td>{row.shiftType}</td>
                <td>{row.pump}</td>
                <td>
                  {categoryLabelMap[
                    row.category as keyof typeof categoryLabelMap
                  ] || row.category}
                </td>
                <td>
                  {row.startTime} - {row.endTime}
                </td>
                <td>{formatMinutes(row.durationMinutes)}</td>
                <td>{row.clientNameSnapshot || "-"}</td>
                <td>
                  {row.loadSourceType === "BUFFER_CONTAINER"
                    ? `Container ${row.sourceContainer || "—"}`
                    : row.loadSourceType === "TRUCK"
                      ? `Carreta ${row.plate || "—"}`
                      : "-"}
                </td>
                <td>{row.container || "-"}</td>
                <td>
                  {row.containerStatus
                    ? containerStatusLabelMap[row.containerStatus]
                    : "-"}
                </td>
                <td>{row.containerReason || "-"}</td>
                <td>{row.createdByEmail}</td>
                <td>{formatDateTime(row.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!rows.length ? (
        <p className="mt-3 text-sm muted">Nenhum item encontrado.</p>
      ) : null}

      {nextCursor ? (
        <div className="mt-3 flex justify-end">
          <button
            className="btn-primary"
            disabled={loading}
            onClick={loadMore}
            type="button"
          >
            {loading ? "Carregando..." : "Carregar mais"}
          </button>
        </div>
      ) : null}
    </section>
  );
}
