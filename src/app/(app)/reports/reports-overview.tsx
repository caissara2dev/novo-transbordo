import Link from "next/link";
import { KeyboardEvent } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import {
  categoryLabelMap,
  containerStatusLabelMap
} from "@/lib/domain/options";
import { formatMinutes, numberFmt } from "./report-formatters";
import { ReportsDashboard } from "./use-reports-dashboard";

type ReportsOverviewProps = ReportsDashboard["overview"];

function handleChartKeyDown(
  event: KeyboardEvent<HTMLElement>,
  onActivate: () => void
) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    onActivate();
  }
}

export function ReportsOverviewSections({
  data,
  kpis,
  openContainers,
  openKpiDrilldown,
  openChartDrilldown
}: ReportsOverviewProps) {
  return (
    <>
      <section className="reports-kpi-grid">
        {kpis.map((kpi) => (
          <button
            className="reports-kpi-card"
            key={kpi.key}
            onClick={openKpiDrilldown}
            type="button"
          >
            <p className="reports-kpi-label">{kpi.label}</p>
            <p className="reports-kpi-value">{kpi.value}</p>
            <p className="reports-kpi-delta">{kpi.delta}</p>
          </button>
        ))}
      </section>

      <OpenContainersSummary openContainers={openContainers} />
      <ReportCharts data={data} onActivate={openChartDrilldown} />
      <IdleRankings data={data} />
      <AuditSummary data={data} />
    </>
  );
}

function OpenContainersSummary({
  openContainers
}: Pick<ReportsOverviewProps, "openContainers">) {
  return (
    <section className="panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="containers-eyebrow">Acompanhamento</p>
          <h2 className="reports-chart-title">
            Containers abertos ({numberFmt.format(openContainers.length)})
          </h2>
        </div>
        <Link className="btn-soft" href="/containers">
          Abrir painel de containers
        </Link>
      </div>
      <div className="metric-grid mt-3">
        {(["PARTIAL", "BUFFER", "BLEND_PARTIAL"] as const).map((status) => (
          <article className="metric-card" key={status}>
            <p className="metric-label">{containerStatusLabelMap[status]}</p>
            <p className="metric-value">
              {
                openContainers.filter((item) => item.status === status)
                  .length
              }
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}

function ReportCharts({
  data,
  onActivate
}: Pick<ReportsOverviewProps, "data"> & { onActivate: () => void }) {
  const chartInteraction = {
    onClick: onActivate,
    onKeyDown: (event: KeyboardEvent<HTMLElement>) =>
      handleChartKeyDown(event, onActivate),
    role: "button",
    tabIndex: 0
  } as const;

  return (
    <section className="grid gap-3 xl:grid-cols-2">
      <article className="panel reports-chart-card" {...chartInteraction}>
        <h2 className="reports-chart-title">Produtivo vs Ocioso por bomba</h2>
        <div className="reports-chart-wrap">
          <ResponsiveContainer height="100%" width="100%">
            <BarChart data={data?.charts.productiveVsIdleByPump || []}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="pump" />
              <YAxis />
              <Tooltip />
              <Legend />
              <Bar
                dataKey="productiveMinutes"
                fill="#3f6262"
                name="Produtivo"
                stackId="a"
              />
              <Bar
                dataKey="idleMinutes"
                fill="#a91c47"
                name="Ocioso"
                stackId="a"
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </article>

      <article className="panel reports-chart-card" {...chartInteraction}>
        <h2 className="reports-chart-title">Minutos por categoria ociosa</h2>
        <div className="reports-chart-wrap">
          <ResponsiveContainer height="100%" width="100%">
            <BarChart
              data={data?.charts.idleByCategoryMinutes || []}
              layout="vertical"
            >
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis type="number" />
              <YAxis
                dataKey="category"
                tickFormatter={(value: string) =>
                  categoryLabelMap[
                    value as keyof typeof categoryLabelMap
                  ] || value
                }
                type="category"
                width={140}
              />
              <Tooltip />
              <Bar dataKey="minutes" fill="#77001e" name="Minutos" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </article>

      <article className="panel reports-chart-card" {...chartInteraction}>
        <h2 className="reports-chart-title">
          Tendência produtivo x ocioso
        </h2>
        <div className="reports-chart-wrap">
          <ResponsiveContainer height="100%" width="100%">
            <LineChart data={data?.charts.trendSeries || []}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="label" />
              <YAxis />
              <Tooltip />
              <Legend />
              <Line
                dataKey="productiveMinutes"
                name="Produtivo"
                stroke="#3f6262"
                strokeWidth={2}
                type="monotone"
              />
              <Line
                dataKey="idleMinutes"
                name="Ocioso"
                stroke="#a91c47"
                strokeWidth={2}
                type="monotone"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </article>

      <article className="panel reports-chart-card" {...chartInteraction}>
        <h2 className="reports-chart-title">Distribuição por turno</h2>
        <div className="reports-chart-wrap">
          <ResponsiveContainer height="100%" width="100%">
            <BarChart data={data?.charts.shiftDistribution || []}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="shiftType" />
              <YAxis />
              <Tooltip />
              <Legend />
              <Bar
                dataKey="productiveMinutes"
                fill="#3f6262"
                name="Produtivo"
                stackId="a"
              />
              <Bar
                dataKey="idleMinutes"
                fill="#a91c47"
                name="Ocioso"
                stackId="a"
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </article>
    </section>
  );
}

function IdleRankings({ data }: Pick<ReportsOverviewProps, "data">) {
  return (
    <section className="grid gap-3 xl:grid-cols-2">
      <article className="panel">
        <h2 className="reports-chart-title">
          Ranking de ociosidade (minutos)
        </h2>
        <div className="space-y-2 mt-3">
          {(data?.charts.idleByCategoryMinutes || []).map((item) => (
            <div className="reports-ranking-row" key={item.category}>
              <span>
                {categoryLabelMap[
                  item.category as keyof typeof categoryLabelMap
                ] || item.category}
              </span>
              <strong>{formatMinutes(item.minutes)}</strong>
            </div>
          ))}
        </div>
      </article>
      <article className="panel">
        <h2 className="reports-chart-title">
          Ranking de ociosidade (quantidade)
        </h2>
        <div className="space-y-2 mt-3">
          {(data?.charts.idleByCategoryCount || []).map((item) => (
            <div className="reports-ranking-row" key={item.category}>
              <span>
                {categoryLabelMap[
                  item.category as keyof typeof categoryLabelMap
                ] || item.category}
              </span>
              <strong>{numberFmt.format(item.count)}</strong>
            </div>
          ))}
        </div>
      </article>
    </section>
  );
}

function AuditSummary({ data }: Pick<ReportsOverviewProps, "data">) {
  return (
    <section className="panel">
      <h2 className="reports-chart-title">Auditoria no período</h2>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div className="metric-card">
          <p className="metric-label">Edições</p>
          <p className="metric-value">
            {numberFmt.format(data?.audit.editedActions || 0)}
          </p>
        </div>
        <div className="metric-card">
          <p className="metric-label">Exclusões</p>
          <p className="metric-value">
            {numberFmt.format(data?.audit.deletedActions || 0)}
          </p>
        </div>
      </div>
    </section>
  );
}
