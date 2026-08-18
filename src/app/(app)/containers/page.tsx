"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/auth/api-fetch";
import {
  containerStatusLabelMap,
  pumpShortLabelMap,
  shiftLabelMap
} from "@/lib/domain/options";
import {
  createLatestRequestCoordinator,
  isAbortError
} from "@/lib/ui/latest-request";
import { appendUniqueContainers } from "@/lib/ui/container-pagination";
import {
  ContainerHistoryItem,
  ContainerStateApiItem,
  PaginatedResponse
} from "@/types/api";

type ContainerListSelection = {
  scope: "open" | "all";
  query: string;
};

function toDateTime(value: string): string {
  return value ? new Date(value).toLocaleString("pt-BR") : "—";
}

export default function ContainersPage() {
  const [items, setItems] = useState<ContainerStateApiItem[]>([]);
  const [history, setHistory] = useState<ContainerHistoryItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [appliedList, setAppliedList] = useState<ContainerListSelection>({
    scope: "open",
    query: ""
  });
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [incomplete, setIncomplete] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRequests = useRef(createLatestRequestCoordinator());
  const historyRequests = useRef(createLatestRequestCoordinator());

  const loadList = useCallback(async ({
    append,
    cursor,
    selection
  }: {
    append: boolean;
    cursor?: string;
    selection: ContainerListSelection;
  }) => {
    const request = listRequests.current.begin();
    setLoading(true);
    setError(null);

    try {
      const searchParams = new URLSearchParams({ scope: selection.scope });
      if (selection.query) {
        searchParams.set("query", selection.query);
      }
      if (cursor) {
        searchParams.set("cursor", cursor);
      }

      const data = await apiFetch<PaginatedResponse<ContainerStateApiItem>>(
        `/api/containers?${searchParams.toString()}`,
        { signal: request.signal }
      );

      if (!request.isCurrent()) {
        return;
      }

      setItems((current) =>
        append
          ? appendUniqueContainers(current, data.items || [])
          : data.items || []
      );
      setAppliedList(selection);
      setNextCursor(data.nextCursor);
      setIncomplete(data.incomplete);
    } catch (err) {
      if (!request.isCurrent() || isAbortError(err)) {
        return;
      }

      setError(err instanceof Error ? err.message : "Erro ao carregar containers.");
    } finally {
      if (request.isCurrent()) {
        setLoading(false);
      }
    }
  }, []);

  const loadOpen = useCallback(
    () =>
      loadList({
        append: false,
        selection: { scope: "open", query: "" }
      }),
    [loadList]
  );

  useEffect(() => {
    const lists = listRequests.current;
    const histories = historyRequests.current;
    const scheduledLoad = window.setTimeout(() => {
      void loadOpen();
    }, 0);

    return () => {
      window.clearTimeout(scheduledLoad);
      lists.cancel();
      histories.cancel();
    };
  }, [loadOpen]);

  const search = async (event: FormEvent) => {
    event.preventDefault();
    await loadList({
      append: false,
      selection: { scope: "all", query: query.trim() }
    });
  };

  const loadMore = () => {
    if (!nextCursor || loading) {
      return;
    }

    void loadList({
      append: true,
      cursor: nextCursor,
      selection: appliedList
    });
  };

  const openHistory = async (container: string) => {
    const request = historyRequests.current.begin();
    setSelected(container);
    setHistory([]);
    setLoadingHistory(true);
    setError(null);

    try {
      const data = await apiFetch<{ items: ContainerHistoryItem[] }>(
        `/api/containers/history?container=${encodeURIComponent(container)}`,
        { signal: request.signal }
      );

      if (!request.isCurrent()) {
        return;
      }

      setHistory(data.items || []);
    } catch (err) {
      if (!request.isCurrent() || isAbortError(err)) {
        return;
      }

      setError(err instanceof Error ? err.message : "Erro ao carregar histórico.");
    } finally {
      if (request.isCurrent()) {
        setLoadingHistory(false);
      }
    }
  };

  return (
    <section className="containers-page space-y-5">
      <header className="containers-hero">
        <div>
          <p className="containers-eyebrow">Rastreabilidade operacional</p>
          <h1>Containers em acompanhamento</h1>
          <p>
            Consulte o estado atual, os ciclos anteriores e todas as placas envolvidas.
          </p>
        </div>
        <div className="containers-open-count">
          <strong>{items.length}</strong>
          <span>na visualização</span>
        </div>
      </header>

      <form className="containers-search" onSubmit={search}>
        <label>
          Código do container
          <input
            className="input-ui"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="ABCU 123456-0"
            value={query}
          />
        </label>
        <button className="btn-primary" disabled={loading} type="submit">
          Pesquisar em todos
        </button>
        <button className="btn-soft" onClick={() => void loadOpen()} type="button">
          Mostrar abertos
        </button>
      </form>

      {error ? <div className="notice error">{error}</div> : null}

      <div className="containers-workbench">
        <section className="containers-list" aria-busy={loading}>
          {items.map((item) => (
            <button
              className={`container-ledger-card ${selected === item.container ? "active" : ""}`}
              key={item.container}
              onClick={() => void openHistory(item.container)}
              type="button"
            >
              <div>
                <span className={`container-status-badge status-${item.status.toLowerCase()}`}>
                  {containerStatusLabelMap[item.status]}
                </span>
                <h2>{item.container}</h2>
                <p>{item.clientNameSnapshot || "Cliente não identificado"}</p>
              </div>
              <dl>
                <div>
                  <dt>Última operação</dt>
                  <dd>{toDateTime(item.operationalAt)}</dd>
                </div>
                <div>
                  <dt>
                    {item.relatedContainer ? "Bomba / Contraparte" : "Bomba / Placa"}
                  </dt>
                  <dd>
                    {pumpShortLabelMap[item.pump]} ·{" "}
                    {item.relatedContainer || item.plate || "Sem placa"}
                  </dd>
                </div>
              </dl>
            </button>
          ))}
          {!loading && !items.length ? (
            <div className="containers-empty">
              <strong>Nenhum container encontrado</strong>
              <span>Ajuste a busca ou volte para os containers abertos.</span>
            </div>
          ) : null}
          {nextCursor ? (
            <button
              className="btn-soft"
              disabled={loading}
              onClick={loadMore}
              type="button"
            >
              {loading
                ? "Carregando..."
                : incomplete
                  ? "Continuar busca"
                  : "Carregar mais"}
            </button>
          ) : null}
        </section>

        <aside
          aria-busy={loadingHistory}
          aria-live="polite"
          className="container-timeline-panel"
        >
          <div className="container-timeline-heading">
            <span>Histórico do ciclo</span>
            <strong>{selected || "Selecione um container"}</strong>
          </div>
          {history.map((event, index) => (
            <article className="container-timeline-event" key={event.id}>
              <span className="timeline-index">{String(index + 1).padStart(2, "0")}</span>
              <div>
                <span className={`container-status-badge status-${event.status.toLowerCase()}`}>
                  {containerStatusLabelMap[event.status]}
                </span>
                <h3>
                  {event.shiftDate} · {shiftLabelMap[event.shiftType]} ·{" "}
                  {pumpShortLabelMap[event.pump]}
                </h3>
                <p>
                  {event.relatedContainer
                    ? `${event.containerRole === "SOURCE" ? "Destino" : "Origem"} ${event.relatedContainer}`
                    : `Placa ${event.plate || "—"}`} ·{" "}
                  {event.clientNameSnapshot || "Sem cliente"}
                </p>
                {event.containerRole === "SOURCE" ? (
                  <p>
                    {event.sourceContainerEmptied
                      ? "Container de origem esvaziado pela transferência."
                      : "Container de origem mantido como pulmão."}
                  </p>
                ) : null}
                {event.containerReason ? <blockquote>{event.containerReason}</blockquote> : null}
              </div>
            </article>
          ))}
          {loadingHistory ? (
            <p className="containers-empty">Carregando histórico...</p>
          ) : null}
          {selected && !loadingHistory && !history.length ? (
            <p className="containers-empty">Sem histórico válido para este container.</p>
          ) : null}
        </aside>
      </div>
    </section>
  );
}
