"use client";

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
import { DateTime } from "luxon";
import Link from "next/link";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useState } from "react";
import { RoleGuard } from "@/components/role-guard";
import { useAuthSession } from "@/lib/auth/use-auth-session";
import { apiFetch } from "@/lib/auth/api-fetch";
import {
  categoryLabelMap,
  categoryOptions,
  containerStatusLabelMap,
  containerStatusOptions,
  pumpOptions,
  shiftOptions
} from "@/lib/domain/options";
import { auth } from "@/lib/firebase/client";
import {
  ClientApiItem,
  ContainerStateApiItem,
  ReportsDrilldownResponse,
  ReportsOverviewResponse,
  ReportGranularity
} from "@/types/api";

const REPORT_ZONE = "America/Sao_Paulo";

type ReportFilters = {
  dateFrom: string;
  dateTo: string;
  granularity: ReportGranularity;
  pump: string;
  shiftType: string;
  category: string;
  clientId: string;
  containerStatus: string;
  includeDeleted: boolean;
};

type PresetKey = "today" | "week" | "month" | "last7" | "custom";

const numberFmt = new Intl.NumberFormat("pt-BR");

function last7DaysFilter(): ReportFilters {
  const now = DateTime.now().setZone(REPORT_ZONE);
  return {
    dateFrom: now.minus({ days: 6 }).toISODate() || "",
    dateTo: now.toISODate() || "",
    granularity: "day",
    pump: "",
    shiftType: "",
    category: "",
    clientId: "",
    containerStatus: "",
    includeDeleted: false
  };
}

function formatMinutes(value: number): string {
  return `${numberFmt.format(Math.round(value))} min`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

function toDeltaBadge(deltaPercent: number | null): string {
  if (deltaPercent === null) return "Sem base";
  if (deltaPercent > 0) return `+${deltaPercent.toFixed(2)}%`;
  return `${deltaPercent.toFixed(2)}%`;
}

function toQuery(filters: ReportFilters): string {
  const qs = new URLSearchParams();
  qs.set("dateFrom", filters.dateFrom);
  qs.set("dateTo", filters.dateTo);
  qs.set("granularity", filters.granularity);
  if (filters.pump) qs.set("pump", filters.pump);
  if (filters.shiftType) qs.set("shiftType", filters.shiftType);
  if (filters.category) qs.set("category", filters.category);
  if (filters.clientId) qs.set("clientId", filters.clientId);
  if (filters.containerStatus) qs.set("containerStatus", filters.containerStatus);
  if (filters.includeDeleted) qs.set("includeDeleted", "true");
  return qs.toString();
}

function formatDateTime(iso: string): string {
  if (!iso) return "-";
  const dt = DateTime.fromISO(iso, { zone: REPORT_ZONE });
  if (!dt.isValid) return "-";
  return dt.setLocale("pt-BR").toFormat("dd/MM/yyyy HH:mm");
}

export default function ReportsPage() {
  const { profile } = useAuthSession();
  const [filters, setFilters] = useState<ReportFilters>(last7DaysFilter());
  const [selectedPreset, setSelectedPreset] = useState<PresetKey>("last7");
  const [clients, setClients] = useState<ClientApiItem[]>([]);
  const [overview, setOverview] = useState<ReportsOverviewResponse | null>(null);
  const [openContainers, setOpenContainers] = useState<ContainerStateApiItem[]>([]);
  const [loadingOverview, setLoadingOverview] = useState(false);
  const [loadingDrilldown, setLoadingDrilldown] = useState(false);
  const [exportingMode, setExportingMode] = useState<"detailed" | "aggregated" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drillSource, setDrillSource] = useState<"kpi" | "chart">("kpi");
  const [drillRows, setDrillRows] = useState<ReportsDrilldownResponse["rows"]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [drillTotal, setDrillTotal] = useState(0);

  const isAdmin = profile?.role === "ADMIN";

  const loadClients = useCallback(async () => {
    const includeInactive = isAdmin ? "?includeInactive=true" : "";
    const data = await apiFetch<{ items: ClientApiItem[] }>(`/api/clients${includeInactive}`);
    setClients(data.items || []);
  }, [isAdmin]);

  const loadOverview = useCallback(async () => {
    setLoadingOverview(true);
    setError(null);
    try {
      const data = await apiFetch<ReportsOverviewResponse>(`/api/reports/overview?${toQuery(filters)}`);
      setOverview(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao carregar relatórios.");
      setOverview(null);
    } finally {
      setLoadingOverview(false);
    }
  }, [filters]);

  const loadOpenContainers = useCallback(async () => {
    const data = await apiFetch<{ items: ContainerStateApiItem[] }>(
      "/api/containers?scope=open"
    );
    setOpenContainers(data.items || []);
  }, []);

  const loadDrilldown = useCallback(
    async (source: "kpi" | "chart", cursor = 0) => {
      setLoadingDrilldown(true);
      setError(null);

      try {
        const data = await apiFetch<ReportsDrilldownResponse>(
          `/api/reports/drilldown?${toQuery(filters)}&source=${source}&cursor=${cursor}&limit=20`
        );

        setDrillSource(source);
        if (cursor === 0) {
          setDrillRows(data.rows);
        } else {
          setDrillRows((prev) => [...prev, ...data.rows]);
        }
        setNextCursor(data.nextCursor);
        setDrillTotal(data.summary.totalRows);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Erro ao carregar detalhamento.");
      } finally {
        setLoadingDrilldown(false);
      }
    },
    [filters]
  );

  useEffect(() => {
    if (!profile?.approved || (profile.role !== "SUPERVISOR" && profile.role !== "ADMIN")) {
      return;
    }

    loadClients().catch((err) => setError(err instanceof Error ? err.message : "Erro ao listar clientes."));
    loadOverview().catch((err) => setError(err instanceof Error ? err.message : "Erro ao carregar relatórios."));
    loadOpenContainers().catch((err) =>
      setError(err instanceof Error ? err.message : "Erro ao carregar containers abertos.")
    );
    loadDrilldown("kpi", 0).catch((err) =>
      setError(err instanceof Error ? err.message : "Erro ao carregar detalhamento.")
    );
  }, [
    profile?.approved,
    profile?.role,
    loadClients,
    loadOverview,
    loadOpenContainers,
    loadDrilldown
  ]);

  const applyPreset = (preset: "today" | "week" | "month" | "last7") => {
    const now = DateTime.now().setZone(REPORT_ZONE);
    setSelectedPreset(preset);

    if (preset === "today") {
      setFilters((prev) => ({
        ...prev,
        dateFrom: now.toISODate() || "",
        dateTo: now.toISODate() || ""
      }));
      return;
    }

    if (preset === "week") {
      setFilters((prev) => ({
        ...prev,
        dateFrom: now.startOf("week").toISODate() || "",
        dateTo: now.toISODate() || ""
      }));
      return;
    }

    if (preset === "month") {
      setFilters((prev) => ({
        ...prev,
        dateFrom: now.startOf("month").toISODate() || "",
        dateTo: now.toISODate() || ""
      }));
      return;
    }

    setFilters((prev) => ({
      ...prev,
      ...last7DaysFilter()
    }));
  };

  const onApplyFilters = async () => {
    await loadOverview();
    await loadDrilldown(drillSource, 0);
  };

  const openChartDrilldown = () => {
    void loadDrilldown("chart", 0);
  };

  const handleChartKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openChartDrilldown();
    }
  };

  const exportCsv = async (mode: "detailed" | "aggregated") => {
    if (!auth.currentUser) {
      setError("Usuário não autenticado.");
      return;
    }

    setExportingMode(mode);
    setError(null);

    try {
      const token = await auth.currentUser.getIdToken();
      const response = await fetch(`/api/reports/export?${toQuery(filters)}&mode=${mode}`, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: "Erro ao exportar." }));
        throw new Error(payload?.error || "Erro ao exportar.");
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download =
        mode === "aggregated"
          ? `relatorio-resumo_${filters.dateFrom}_a_${filters.dateTo}.csv`
          : `relatorio-detalhado_${filters.dateFrom}_a_${filters.dateTo}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao exportar CSV.");
    } finally {
      setExportingMode(null);
    }
  };

  const kpis = useMemo(() => {
    if (!overview) return [];

    return [
      {
        key: "totalMinutes",
        label: "Minutos totais",
        value: formatMinutes(overview.kpis.totalMinutes.current),
        delta: toDeltaBadge(overview.kpis.totalMinutes.deltaPercent)
      },
      {
        key: "productiveMinutes",
        label: "Minutos produtivos",
        value: formatMinutes(overview.kpis.productiveMinutes.current),
        delta: toDeltaBadge(overview.kpis.productiveMinutes.deltaPercent)
      },
      {
        key: "idleMinutes",
        label: "Minutos ociosos",
        value: formatMinutes(overview.kpis.idleMinutes.current),
        delta: toDeltaBadge(overview.kpis.idleMinutes.deltaPercent)
      },
      {
        key: "productiveRateMinutes",
        label: "Produtividade (% minutos)",
        value: formatPercent(overview.kpis.productiveRateMinutes.current),
        delta: toDeltaBadge(overview.kpis.productiveRateMinutes.deltaPercent)
      },
      {
        key: "totalEvents",
        label: "Eventos totais",
        value: numberFmt.format(overview.kpis.totalEvents.current),
        delta: toDeltaBadge(overview.kpis.totalEvents.deltaPercent)
      },
      {
        key: "productiveRateEvents",
        label: "Produtividade (% eventos)",
        value: formatPercent(overview.kpis.productiveRateEvents.current),
        delta: toDeltaBadge(overview.kpis.productiveRateEvents.deltaPercent)
      },
      {
        key: "avgProductiveTransbordoMinutes",
        label: "Tempo médio transbordo",
        value: formatMinutes(overview.kpis.avgProductiveTransbordoMinutes.current),
        delta: toDeltaBadge(overview.kpis.avgProductiveTransbordoMinutes.deltaPercent)
      }
    ];
  }, [overview]);

  return (
    <RoleGuard allowed={["SUPERVISOR", "ADMIN"]}>
      <section className="space-y-4">
        <header className="reports-header">
          <div>
            <p className="pill">Análise operacional</p>
            <h1 className="panel-title mt-2 text-2xl">Relatórios V2</h1>
            <p className="mt-1 text-sm muted">
              Dashboard analítico com comparativo de período, drilldown e exportação CSV.
            </p>
          </div>
          <div className="reports-export-actions">
            <button
              className="btn-soft"
              disabled={exportingMode !== null}
              onClick={() => exportCsv("detailed")}
              type="button"
            >
              {exportingMode === "detailed" ? "Exportando..." : "CSV detalhado"}
            </button>
            <button
              className="btn-primary"
              disabled={exportingMode !== null}
              onClick={() => exportCsv("aggregated")}
              type="button"
            >
              {exportingMode === "aggregated" ? "Exportando..." : "CSV agregado"}
            </button>
          </div>
        </header>

        {error ? <div className="notice error">{error}</div> : null}

        <section className="panel reports-filter-panel">
          <div className="reports-preset-row">
            <button
              aria-pressed={selectedPreset === "today"}
              className={`btn-soft reports-preset-btn ${selectedPreset === "today" ? "active" : ""}`}
              onClick={() => applyPreset("today")}
              type="button"
            >
              Hoje
            </button>
            <button
              aria-pressed={selectedPreset === "week"}
              className={`btn-soft reports-preset-btn ${selectedPreset === "week" ? "active" : ""}`}
              onClick={() => applyPreset("week")}
              type="button"
            >
              Semana atual
            </button>
            <button
              aria-pressed={selectedPreset === "month"}
              className={`btn-soft reports-preset-btn ${selectedPreset === "month" ? "active" : ""}`}
              onClick={() => applyPreset("month")}
              type="button"
            >
              Mês atual
            </button>
            <button
              aria-pressed={selectedPreset === "last7"}
              className={`btn-soft reports-preset-btn ${selectedPreset === "last7" ? "active" : ""}`}
              onClick={() => applyPreset("last7")}
              type="button"
            >
              Últimos 7 dias
            </button>
            {selectedPreset === "custom" ? (
              <span className="reports-custom-chip">Personalizado</span>
            ) : null}
          </div>

          <div className="grid gap-3 md:grid-cols-4">
            <label className="field-label">
              Data de
              <input
                className="input-ui"
                onChange={(e) => {
                  setSelectedPreset("custom");
                  setFilters((prev) => ({ ...prev, dateFrom: e.target.value }));
                }}
                type="date"
                value={filters.dateFrom}
              />
            </label>
            <label className="field-label">
              Data até
              <input
                className="input-ui"
                onChange={(e) => {
                  setSelectedPreset("custom");
                  setFilters((prev) => ({ ...prev, dateTo: e.target.value }));
                }}
                type="date"
                value={filters.dateTo}
              />
            </label>
            <label className="field-label">
              Granularidade
              <select
                className="select-ui"
                onChange={(e) =>
                  setFilters((prev) => ({
                    ...prev,
                    granularity: e.target.value as ReportGranularity
                  }))
                }
                value={filters.granularity}
              >
                <option value="day">Dia</option>
                <option value="week">Semana</option>
                <option value="month">Mês</option>
              </select>
            </label>
            <label className="field-label">
              Bomba
              <select
                className="select-ui"
                onChange={(e) => setFilters((prev) => ({ ...prev, pump: e.target.value }))}
                value={filters.pump}
              >
                <option value="">Todas</option>
                {pumpOptions.map((pump) => (
                  <option key={pump.value} value={pump.value}>
                    {pump.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-label">
              Turno
              <select
                className="select-ui"
                onChange={(e) => setFilters((prev) => ({ ...prev, shiftType: e.target.value }))}
                value={filters.shiftType}
              >
                <option value="">Todos</option>
                {shiftOptions.map((shift) => (
                  <option key={shift.value} value={shift.value}>
                    {shift.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-label">
              Categoria
              <select
                className="select-ui"
                onChange={(e) => setFilters((prev) => ({ ...prev, category: e.target.value }))}
                value={filters.category}
              >
                <option value="">Todas</option>
                {categoryOptions.map((cat) => (
                  <option key={cat.value} value={cat.value}>
                    {cat.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-label">
              Cliente
              <select
                className="select-ui"
                onChange={(e) => setFilters((prev) => ({ ...prev, clientId: e.target.value }))}
                value={filters.clientId}
              >
                <option value="">Todos</option>
                {clients.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-label">
              Estado do container
              <select
                className="select-ui"
                onChange={(e) =>
                  setFilters((prev) => ({ ...prev, containerStatus: e.target.value }))
                }
                value={filters.containerStatus}
              >
                <option value="">Todos</option>
                {containerStatusOptions.map((status) => (
                  <option key={status.value} value={status.value}>
                    {status.label}
                  </option>
                ))}
              </select>
            </label>

            <div className="reports-filter-actions">
              {isAdmin ? (
                <label className="reports-toggle muted">
                  <input
                    checked={filters.includeDeleted}
                    onChange={(e) =>
                      setFilters((prev) => ({ ...prev, includeDeleted: e.target.checked }))
                    }
                    type="checkbox"
                  />
                  Incluir excluídos
                </label>
              ) : null}
              <button className="btn-primary" disabled={loadingOverview} onClick={onApplyFilters} type="button">
                {loadingOverview ? "Aplicando..." : "Aplicar filtros"}
              </button>
            </div>
          </div>

          {overview ? (
            <p className="mt-2 text-xs muted">
              Limites: até {overview.limits.maxPeriodDays} dias e {numberFmt.format(overview.limits.maxEventsProcessed)}
              {" "}
              eventos por consulta.
            </p>
          ) : null}
        </section>

        <section className="reports-kpi-grid">
          {kpis.map((kpi) => (
            <button
              className="reports-kpi-card"
              key={kpi.key}
              onClick={() => loadDrilldown("kpi", 0)}
              type="button"
            >
              <p className="reports-kpi-label">{kpi.label}</p>
              <p className="reports-kpi-value">{kpi.value}</p>
              <p className="reports-kpi-delta">{kpi.delta}</p>
            </button>
          ))}
        </section>

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
                  {openContainers.filter((item) => item.status === status).length}
                </p>
              </article>
            ))}
          </div>
        </section>

        <section className="grid gap-3 xl:grid-cols-2">
          <article
            className="panel reports-chart-card"
            onClick={openChartDrilldown}
            onKeyDown={handleChartKeyDown}
            role="button"
            tabIndex={0}
          >
            <h2 className="reports-chart-title">Produtivo vs Ocioso por bomba</h2>
            <div className="reports-chart-wrap">
              <ResponsiveContainer height="100%" width="100%">
                <BarChart data={overview?.charts.productiveVsIdleByPump || []}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="pump" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="productiveMinutes" fill="#3f6262" name="Produtivo" stackId="a" />
                  <Bar dataKey="idleMinutes" fill="#a91c47" name="Ocioso" stackId="a" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </article>

          <article
            className="panel reports-chart-card"
            onClick={openChartDrilldown}
            onKeyDown={handleChartKeyDown}
            role="button"
            tabIndex={0}
          >
            <h2 className="reports-chart-title">Minutos por categoria ociosa</h2>
            <div className="reports-chart-wrap">
              <ResponsiveContainer height="100%" width="100%">
                <BarChart data={overview?.charts.idleByCategoryMinutes || []} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis type="number" />
                  <YAxis
                    dataKey="category"
                    tickFormatter={(value: string) => categoryLabelMap[value as keyof typeof categoryLabelMap] || value}
                    type="category"
                    width={140}
                  />
                  <Tooltip />
                  <Bar dataKey="minutes" fill="#77001e" name="Minutos" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </article>

          <article
            className="panel reports-chart-card"
            onClick={openChartDrilldown}
            onKeyDown={handleChartKeyDown}
            role="button"
            tabIndex={0}
          >
            <h2 className="reports-chart-title">Tendência produtivo x ocioso</h2>
            <div className="reports-chart-wrap">
              <ResponsiveContainer height="100%" width="100%">
                <LineChart data={overview?.charts.trendSeries || []}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="label" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Line dataKey="productiveMinutes" name="Produtivo" stroke="#3f6262" strokeWidth={2} type="monotone" />
                  <Line dataKey="idleMinutes" name="Ocioso" stroke="#a91c47" strokeWidth={2} type="monotone" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </article>

          <article
            className="panel reports-chart-card"
            onClick={openChartDrilldown}
            onKeyDown={handleChartKeyDown}
            role="button"
            tabIndex={0}
          >
            <h2 className="reports-chart-title">Distribuição por turno</h2>
            <div className="reports-chart-wrap">
              <ResponsiveContainer height="100%" width="100%">
                <BarChart data={overview?.charts.shiftDistribution || []}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="shiftType" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="productiveMinutes" fill="#3f6262" name="Produtivo" stackId="a" />
                  <Bar dataKey="idleMinutes" fill="#a91c47" name="Ocioso" stackId="a" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </article>
        </section>

        <section className="grid gap-3 xl:grid-cols-2">
          <article className="panel">
            <h2 className="reports-chart-title">Ranking de ociosidade (minutos)</h2>
            <div className="space-y-2 mt-3">
              {(overview?.charts.idleByCategoryMinutes || []).map((item) => (
                <div className="reports-ranking-row" key={item.category}>
                  <span>{categoryLabelMap[item.category as keyof typeof categoryLabelMap] || item.category}</span>
                  <strong>{formatMinutes(item.minutes)}</strong>
                </div>
              ))}
            </div>
          </article>
          <article className="panel">
            <h2 className="reports-chart-title">Ranking de ociosidade (quantidade)</h2>
            <div className="space-y-2 mt-3">
              {(overview?.charts.idleByCategoryCount || []).map((item) => (
                <div className="reports-ranking-row" key={item.category}>
                  <span>{categoryLabelMap[item.category as keyof typeof categoryLabelMap] || item.category}</span>
                  <strong>{numberFmt.format(item.count)}</strong>
                </div>
              ))}
            </div>
          </article>
        </section>

        <section className="panel">
          <h2 className="reports-chart-title">Auditoria no período</h2>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <div className="metric-card">
              <p className="metric-label">Edições</p>
              <p className="metric-value">{numberFmt.format(overview?.audit.editedActions || 0)}</p>
            </div>
            <div className="metric-card">
              <p className="metric-label">Exclusões</p>
              <p className="metric-value">{numberFmt.format(overview?.audit.deletedActions || 0)}</p>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="reports-chart-title">
              Detalhamento ({drillSource === "kpi" ? "KPI" : "Gráfico"}) - {numberFmt.format(drillTotal)} linhas
            </h2>
            <button className="btn-soft" disabled={loadingDrilldown} onClick={() => loadDrilldown(drillSource, 0)} type="button">
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
                  <th>Container</th>
                  <th>Estado</th>
                  <th>Motivo</th>
                  <th>Criado por</th>
                  <th>Editado em</th>
                </tr>
              </thead>
              <tbody>
                {drillRows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.shiftDate}</td>
                    <td>{row.shiftType}</td>
                    <td>{row.pump}</td>
                    <td>{categoryLabelMap[row.category as keyof typeof categoryLabelMap] || row.category}</td>
                    <td>
                      {row.startTime} - {row.endTime}
                    </td>
                    <td>{formatMinutes(row.durationMinutes)}</td>
                    <td>{row.clientNameSnapshot || "-"}</td>
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

          {!drillRows.length ? <p className="mt-3 text-sm muted">Nenhum item encontrado.</p> : null}

          {nextCursor ? (
            <div className="mt-3 flex justify-end">
              <button
                className="btn-primary"
                disabled={loadingDrilldown}
                onClick={() => loadDrilldown(drillSource, Number(nextCursor))}
                type="button"
              >
                {loadingDrilldown ? "Carregando..." : "Carregar mais"}
              </button>
            </div>
          ) : null}
        </section>
      </section>
    </RoleGuard>
  );
}
