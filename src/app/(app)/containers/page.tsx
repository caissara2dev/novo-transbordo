"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/auth/api-fetch";
import {
  containerStatusLabelMap,
  pumpShortLabelMap,
  shiftLabelMap
} from "@/lib/domain/options";
import {
  ContainerHistoryItem,
  ContainerStateApiItem
} from "@/types/api";

function toDateTime(value: string): string {
  return value ? new Date(value).toLocaleString("pt-BR") : "—";
}

export default function ContainersPage() {
  const [items, setItems] = useState<ContainerStateApiItem[]>([]);
  const [history, setHistory] = useState<ContainerHistoryItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadOpen = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<{ items: ContainerStateApiItem[] }>(
        "/api/containers?scope=open"
      );
      setItems(data.items || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao carregar containers.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOpen();
  }, [loadOpen]);

  const search = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<{ items: ContainerStateApiItem[] }>(
        `/api/containers?scope=all&query=${encodeURIComponent(query)}`
      );
      setItems(data.items || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao pesquisar container.");
    } finally {
      setLoading(false);
    }
  };

  const openHistory = async (container: string) => {
    setSelected(container);
    setError(null);
    try {
      const data = await apiFetch<{ items: ContainerHistoryItem[] }>(
        `/api/containers/history?container=${encodeURIComponent(container)}`
      );
      setHistory(data.items || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao carregar histórico.");
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
                  <dt>Bomba / Placa</dt>
                  <dd>
                    {pumpShortLabelMap[item.pump]} · {item.plate}
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
        </section>

        <aside className="container-timeline-panel">
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
                  Placa {event.plate || "—"} · {event.clientNameSnapshot || "Sem cliente"}
                </p>
                {event.containerReason ? <blockquote>{event.containerReason}</blockquote> : null}
              </div>
            </article>
          ))}
          {selected && !history.length ? (
            <p className="containers-empty">Sem histórico válido para este container.</p>
          ) : null}
        </aside>
      </div>
    </section>
  );
}
