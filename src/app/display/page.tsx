"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DisplayGate } from "@/components/display-gate";
import { apiFetch } from "@/lib/auth/api-fetch";
import { isAbortError } from "@/lib/ui/latest-request";
import { DisplayOverviewResponse } from "@/types/api";

const DISPLAY_ZONE = "America/Sao_Paulo";
const CLIENTS_PER_PAGE = 8;
const REFRESH_INTERVAL_MS = 30_000;
const ROTATION_INTERVAL_MS = 10_000;

const timeFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: DISPLAY_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false
});

const dateFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: DISPLAY_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric"
});

function formatOperationalDate(value: string): string {
  const [year, month, day] = value.split("-");
  return year && month && day ? `${day}/${month}/${year}` : value;
}

function formatAverage(value: number | null): string {
  if (value === null) return "—";
  return `${value.toLocaleString("pt-BR", {
    minimumFractionDigits: value % 1 ? 1 : 0,
    maximumFractionDigits: 1
  })} min`;
}

function ClientNamesVisibilityIcon({ action }: { action: "hide" | "show" }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      focusable="false"
      viewBox="0 0 24 24"
    >
      <path
        d="M2.75 12s3.4-6 9.25-6 9.25 6 9.25 6-3.4 6-9.25 6S2.75 12 2.75 12Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <circle cx="12" cy="12" r="2.75" stroke="currentColor" strokeWidth="1.8" />
      {action === "hide" ? (
        <path
          d="m4.25 4.25 15.5 15.5"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="2"
        />
      ) : null}
    </svg>
  );
}

function DisplayContent() {
  const [overview, setOverview] = useState<DisplayOverviewResponse | null>(null);
  const [stale, setStale] = useState(false);
  const [initialError, setInitialError] = useState(false);
  const [clock, setClock] = useState(() => new Date());
  const [page, setPage] = useState(0);
  const [clientNamesVisible, setClientNamesVisible] = useState(true);
  const hasOverview = useRef(false);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await apiFetch<DisplayOverviewResponse>("/api/display/overview", {
        cache: "no-store",
        signal
      });
      const nextPageCount = Math.max(
        1,
        Math.ceil(next.clients.length / CLIENTS_PER_PAGE)
      );

      hasOverview.current = true;
      setOverview(next);
      setPage((current) => Math.min(current, nextPageCount - 1));
      setStale(false);
      setInitialError(false);
    } catch (reason) {
      if (isAbortError(reason)) {
        return;
      }

      setStale(true);
      setInitialError(!hasOverview.current);
    }
  }, []);

  useEffect(() => {
    let activeController: AbortController | null = null;
    const runRefresh = () => {
      activeController?.abort();
      activeController = new AbortController();
      void refresh(activeController.signal);
    };
    const initialRefresh = window.setTimeout(runRefresh, 0);
    const interval = window.setInterval(runRefresh, REFRESH_INTERVAL_MS);

    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(interval);
      activeController?.abort();
    };
  }, [refresh]);

  useEffect(() => {
    const interval = window.setInterval(() => setClock(new Date()), 1_000);
    return () => window.clearInterval(interval);
  }, []);

  const pageCount = Math.max(1, Math.ceil((overview?.clients.length || 0) / CLIENTS_PER_PAGE));

  useEffect(() => {
    if (pageCount <= 1) return;
    const interval = window.setInterval(
      () => setPage((current) => (current + 1) % pageCount),
      ROTATION_INTERVAL_MS
    );
    return () => window.clearInterval(interval);
  }, [pageCount]);

  const visibleClients = useMemo(
    () =>
      (overview?.clients || []).slice(
        page * CLIENTS_PER_PAGE,
        page * CLIENTS_PER_PAGE + CLIENTS_PER_PAGE
      ),
    [overview, page]
  );
  const privacyActionTitle = clientNamesVisible
    ? "Ocultar nomes dos clientes"
    : "Exibir nomes dos clientes";

  if (!overview && initialError) {
    return (
      <main className="display-screen display-connection-state">
        <div className="display-connection-panel">
          <span className="display-signal display-signal-off" aria-hidden="true" />
          <p className="display-kicker">Display operacional</p>
          <h1>Conexão indisponível</h1>
          <p>Aguardando a próxima tentativa automática de atualização.</p>
        </div>
      </main>
    );
  }

  if (!overview) {
    return (
      <main className="display-screen display-connection-state">
        <div className="display-connection-panel">
          <span className="display-signal" aria-hidden="true" />
          <p className="display-kicker">Display operacional</p>
          <h1>Carregando operação</h1>
          <p>Sincronizando os dados do turno atual.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="display-screen">
      <header className="display-header">
        <div className="display-brand">
          <span className={`display-signal ${stale ? "display-signal-warn" : ""}`} aria-hidden="true" />
          <div>
            <p className="display-kicker">Terminal ao vivo</p>
            <h1>Controle Transbordo</h1>
          </div>
        </div>

        <div className="display-operational-date">
          <span>Data operacional</span>
          <strong>{formatOperationalDate(overview.operationalDate)}</strong>
        </div>

        <div className="display-header-actions">
          <div className="display-clock">
            <strong>{timeFormatter.format(clock)}</strong>
            <span>{dateFormatter.format(clock)}</span>
            <small>
              Atualizado às {timeFormatter.format(new Date(overview.generatedAt))}
            </small>
          </div>
          <button
            aria-label="Privacidade dos nomes dos clientes"
            aria-pressed={!clientNamesVisible}
            className={`display-privacy-toggle ${
              clientNamesVisible ? "" : "privacy-active"
            }`}
            onClick={() => setClientNamesVisible((visible) => !visible)}
            title={privacyActionTitle}
            type="button"
          >
            <ClientNamesVisibilityIcon action={clientNamesVisible ? "hide" : "show"} />
          </button>
        </div>
      </header>

      {stale ? (
        <div className="display-stale-banner" role="status">
          <span aria-hidden="true">!</span>
          Dados desatualizados — mantendo a última leitura válida
        </div>
      ) : null}

      <section className="display-grid" aria-live="polite">
        <div className="display-kpis">
          <article className="display-metric display-metric-primary">
            <p>Finalizados hoje</p>
            <strong>{overview.finalizedTotal}</strong>
            <span>Cheios + Blend cheios</span>
          </article>

          <article className="display-metric display-metric-time">
            <p>Tempo médio produtivo</p>
            <strong>{formatAverage(overview.averageProductiveMinutes)}</strong>
            <span>Todos os lançamentos do dia</span>
          </article>

          <article className="display-open-panel">
            <div className="display-open-total">
              <div>
                <p>Containers abertos agora</p>
                <span>Estado atual do pátio</span>
              </div>
              <strong>{overview.openContainers.total}</strong>
            </div>

            <div className="display-open-breakdown">
              <div>
                <span className="display-status-mark status-partial-mark" />
                <p>Parcial</p>
                <strong>{overview.openContainers.partial}</strong>
              </div>
              <div>
                <span className="display-status-mark status-buffer-mark" />
                <p>Pulmão</p>
                <strong>{overview.openContainers.buffer}</strong>
              </div>
              <div>
                <span className="display-status-mark status-blend-mark" />
                <p>Blend Parcial</p>
                <strong>{overview.openContainers.blendPartial}</strong>
              </div>
            </div>
          </article>
        </div>

        <article className="display-clients">
          <div className="display-clients-title">
            <div>
              <p className="display-kicker">Movimento por cliente</p>
              <h2>Resumo do pátio</h2>
            </div>
            {pageCount > 1 ? (
              <span>
                Página {page + 1} / {pageCount}
              </span>
            ) : null}
          </div>

          <div className="display-table" role="table" aria-label="Contagens por cliente">
            <div className="display-table-row display-table-head" role="row">
              <span role="columnheader">Cliente</span>
              <span role="columnheader">Finalizados hoje</span>
              <span role="columnheader">Abertos agora</span>
            </div>

            {visibleClients.map((client, index) => {
              const clientNumber = page * CLIENTS_PER_PAGE + index + 1;

              return (
                <div
                  className="display-table-row"
                  role="row"
                  key={client.clientId}
                  style={{ "--row-index": index } as React.CSSProperties}
                >
                  <strong role="cell">
                    {clientNamesVisible ? client.clientName : `Cliente ${clientNumber}`}
                  </strong>
                  <span role="cell">{client.finalizedToday}</span>
                  <span role="cell">{client.openNow}</span>
                </div>
              );
            })}

            {!visibleClients.length ? (
              <div className="display-empty">
                <strong>Sem movimentação registrada</strong>
                <span>Nenhuma finalização hoje ou container aberto.</span>
              </div>
            ) : null}
          </div>

          <div className="display-page-progress" aria-hidden="true">
            {Array.from({ length: pageCount }, (_, index) => (
              <span className={index === page ? "active" : ""} key={index} />
            ))}
          </div>
        </article>
      </section>
    </main>
  );
}

export default function DisplayPage() {
  return (
    <DisplayGate>
      <DisplayContent />
    </DisplayGate>
  );
}
