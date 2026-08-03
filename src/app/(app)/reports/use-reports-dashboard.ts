"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { apiFetch } from "@/lib/auth/api-fetch";
import {
  filtersAreEqual,
  ReportFilters,
  toReportQuery
} from "@/lib/ui/filters";
import {
  createLatestRequestCoordinator,
  isAbortError
} from "@/lib/ui/latest-request";
import {
  ClientApiItem,
  ContainerStateApiItem,
  ReportsDrilldownResponse,
  ReportsOverviewResponse
} from "@/types/api";
import { UserDoc } from "@/types/domain";
import {
  buildReportKpis,
  filtersForPreset,
  last7DaysFilter,
  PresetKey
} from "./report-formatters";

type DrillSource = "kpi" | "chart";
type ExportMode = "detailed" | "aggregated";
type CsvFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Blob>;

type UseReportsDashboardOptions = {
  profile: UserDoc | null;
  fetchCsv: CsvFetcher;
};

export function useReportsDashboard({
  profile,
  fetchCsv
}: UseReportsDashboardOptions) {
  const initialFilters = useMemo(() => last7DaysFilter(), []);
  const [draftFilters, setDraftFilters] = useState<ReportFilters>(() => ({
    ...initialFilters
  }));
  const [appliedFilters, setAppliedFilters] = useState<ReportFilters>(() => ({
    ...initialFilters
  }));
  const [selectedPreset, setSelectedPreset] = useState<PresetKey>("last7");
  const [clients, setClients] = useState<ClientApiItem[]>([]);
  const [overview, setOverview] = useState<ReportsOverviewResponse | null>(null);
  const [openContainers, setOpenContainers] = useState<ContainerStateApiItem[]>(
    []
  );
  const [loadingOverview, setLoadingOverview] = useState(false);
  const [loadingDrilldown, setLoadingDrilldown] = useState(false);
  const [exportingMode, setExportingMode] = useState<ExportMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drillSource, setDrillSource] = useState<DrillSource>("kpi");
  const [drillRows, setDrillRows] = useState<
    ReportsDrilldownResponse["rows"]
  >([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [drillTotal, setDrillTotal] = useState(0);
  const metadataRequests = useRef(createLatestRequestCoordinator());
  const overviewRequests = useRef(createLatestRequestCoordinator());
  const drilldownRequests = useRef(createLatestRequestCoordinator());

  const isAdmin = profile?.role === "ADMIN";
  const canViewReports =
    profile?.approved &&
    (profile.role === "SUPERVISOR" || profile.role === "ADMIN");

  const loadMetadata = useCallback(async () => {
    const request = metadataRequests.current.begin();
    const includeInactive = isAdmin ? "?includeInactive=true" : "";

    try {
      const [clientsData, containersData] = await Promise.all([
        apiFetch<{ items: ClientApiItem[] }>(`/api/clients${includeInactive}`, {
          signal: request.signal
        }),
        apiFetch<{ items: ContainerStateApiItem[] }>(
          "/api/containers?scope=open",
          { signal: request.signal }
        )
      ]);

      if (!request.isCurrent()) return;

      setClients(clientsData.items || []);
      setOpenContainers(containersData.items || []);
    } catch (caughtError) {
      if (!request.isCurrent() || isAbortError(caughtError)) return;

      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Erro ao carregar dados auxiliares dos relatórios."
      );
    }
  }, [isAdmin]);

  const loadOverview = useCallback(async (filters: ReportFilters) => {
    const request = overviewRequests.current.begin();
    setLoadingOverview(true);
    setError(null);

    try {
      const data = await apiFetch<ReportsOverviewResponse>(
        `/api/reports/overview?${toReportQuery(filters)}`,
        { signal: request.signal }
      );

      if (!request.isCurrent()) return;
      setOverview(data);
    } catch (caughtError) {
      if (!request.isCurrent() || isAbortError(caughtError)) return;

      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Erro ao carregar relatórios."
      );
      setOverview(null);
    } finally {
      if (request.isCurrent()) setLoadingOverview(false);
    }
  }, []);

  const loadDrilldown = useCallback(
    async (source: DrillSource, cursor: number, filters: ReportFilters) => {
      const request = drilldownRequests.current.begin();
      setLoadingDrilldown(true);
      setError(null);

      try {
        const data = await apiFetch<ReportsDrilldownResponse>(
          `/api/reports/drilldown?${toReportQuery(filters)}&source=${source}&cursor=${cursor}&limit=20`,
          { signal: request.signal }
        );

        if (!request.isCurrent()) return;

        setDrillSource(source);
        setDrillRows((previousRows) =>
          cursor === 0 ? data.rows : [...previousRows, ...data.rows]
        );
        setNextCursor(data.nextCursor);
        setDrillTotal(data.summary.totalRows);
      } catch (caughtError) {
        if (!request.isCurrent() || isAbortError(caughtError)) return;

        setError(
          caughtError instanceof Error
            ? caughtError.message
            : "Erro ao carregar detalhamento."
        );
      } finally {
        if (request.isCurrent()) setLoadingDrilldown(false);
      }
    },
    []
  );

  useEffect(() => {
    const requests = metadataRequests.current;

    if (!canViewReports) {
      requests.cancel();
      return;
    }

    void loadMetadata();
    return () => requests.cancel();
  }, [canViewReports, loadMetadata]);

  useEffect(() => {
    const overviews = overviewRequests.current;
    const drilldowns = drilldownRequests.current;

    if (!canViewReports) {
      overviews.cancel();
      drilldowns.cancel();
      return;
    }

    const timer = window.setTimeout(() => {
      void Promise.all([
        loadOverview(appliedFilters),
        loadDrilldown("kpi", 0, appliedFilters)
      ]);
    }, 0);

    return () => {
      window.clearTimeout(timer);
      overviews.cancel();
      drilldowns.cancel();
    };
  }, [canViewReports, appliedFilters, loadOverview, loadDrilldown]);

  const updateDraftFilters = useCallback((patch: Partial<ReportFilters>) => {
    setDraftFilters((previousFilters) => ({
      ...previousFilters,
      ...patch
    }));
  }, []);

  const updateCustomDate = useCallback(
    (field: "dateFrom" | "dateTo", value: string) => {
      setSelectedPreset("custom");
      updateDraftFilters({ [field]: value });
    },
    [updateDraftFilters]
  );

  const applyPreset = useCallback(
    (preset: Exclude<PresetKey, "custom">) => {
      setSelectedPreset(preset);
      setDraftFilters((previousFilters) =>
        filtersForPreset(previousFilters, preset)
      );
    },
    []
  );

  const applyFilters = useCallback(() => {
    setAppliedFilters((currentAppliedFilters) =>
      filtersAreEqual(draftFilters, currentAppliedFilters)
        ? currentAppliedFilters
        : { ...draftFilters }
    );
  }, [draftFilters]);

  const refreshDrilldown = useCallback(
    (source: DrillSource = drillSource) =>
      loadDrilldown(source, 0, appliedFilters),
    [appliedFilters, drillSource, loadDrilldown]
  );

  const loadMoreDrilldown = useCallback(() => {
    if (!nextCursor) return Promise.resolve();
    return loadDrilldown(drillSource, Number(nextCursor), appliedFilters);
  }, [appliedFilters, drillSource, loadDrilldown, nextCursor]);

  const exportCsv = useCallback(
    async (mode: ExportMode) => {
      setExportingMode(mode);
      setError(null);

      try {
        const blob = await fetchCsv(
          `/api/reports/export?${toReportQuery(appliedFilters)}&mode=${mode}`
        );
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download =
          mode === "aggregated"
            ? `relatorio-resumo_${appliedFilters.dateFrom}_a_${appliedFilters.dateTo}.csv`
            : `relatorio-detalhado_${appliedFilters.dateFrom}_a_${appliedFilters.dateTo}.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
      } catch (caughtError) {
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : "Erro ao exportar CSV."
        );
      } finally {
        setExportingMode(null);
      }
    },
    [appliedFilters, fetchCsv]
  );

  return {
    error,
    exportingMode,
    exportCsv,
    filters: {
      draftFilters,
      selectedPreset,
      clients,
      isAdmin,
      loading: loadingOverview || loadingDrilldown,
      limits: overview?.limits ?? null,
      updateDraftFilters,
      updateCustomDate,
      applyPreset,
      applyFilters
    },
    overview: {
      data: overview,
      kpis: buildReportKpis(overview),
      openContainers,
      openKpiDrilldown: () => refreshDrilldown("kpi"),
      openChartDrilldown: () => refreshDrilldown("chart")
    },
    drilldown: {
      source: drillSource,
      rows: drillRows,
      total: drillTotal,
      nextCursor,
      loading: loadingDrilldown,
      refresh: () => refreshDrilldown(),
      loadMore: loadMoreDrilldown
    }
  };
}

export type ReportsDashboard = ReturnType<typeof useReportsDashboard>;
