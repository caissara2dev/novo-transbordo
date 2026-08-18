"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RoleGuard } from "@/components/role-guard";
import { apiFetch } from "@/lib/auth/api-fetch";
import { useAuthSession } from "@/lib/auth/use-auth-session";
import { isAbortError } from "@/lib/ui/latest-request";
import type { ClientApiItem } from "@/types/api";
import { CheckinDetailPanel } from "./checkin-detail-panel";
import type { CheckinManagerAction } from "./checkin-detail-panel";
import {
  canManageCheckins,
  checkinStatusOptions,
  filterCheckins,
  statusLabel
} from "./checkins-ui";
import type {
  InternalCheckinDetail,
  InternalCheckinListItem
} from "./checkins-ui";
import type { CheckinStatus } from "@/lib/domain/checkins";

type ListResponse = { items: InternalCheckinListItem[] };
type DetailResponse = { item: InternalCheckinDetail };

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export default function CheckinsPage() {
  const { profile } = useAuthSession();
  const canManage = canManageCheckins(profile?.role);
  const [items, setItems] = useState<InternalCheckinListItem[]>([]);
  const [detail, setDetail] = useState<InternalCheckinDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [clients, setClients] = useState<ClientApiItem[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<CheckinStatus | "">("");
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const filteredItems = useMemo(
    () => filterCheckins(items, { query, status }),
    [items, query, status]
  );

  const loadList = useCallback(async (signal?: AbortSignal) => {
    const data = await apiFetch<ListResponse>("/api/checkins", { signal });
    setItems(data.items || []);
  }, []);

  const loadDetail = useCallback(async (id: string, signal?: AbortSignal) => {
    const data = await apiFetch<DetailResponse>(
      `/api/checkins/${encodeURIComponent(id)}`,
      { signal }
    );
    setDetail(data.item);
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    void apiFetch<ListResponse>("/api/checkins", { signal: controller.signal })
      .then((data) => setItems(data.items || []))
      .catch((reason) => {
        if (!controller.signal.aborted && !isAbortError(reason)) {
          setError(errorMessage(reason, "Erro ao carregar check-ins."));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingList(false);
      });

    return () => controller.abort();
  }, [loadList]);

  useEffect(() => {
    if (!canManage) return;
    const controller = new AbortController();

    void apiFetch<{ items: ClientApiItem[] }>("/api/clients", {
      signal: controller.signal
    })
      .then((data) => setClients(data.items || []))
      .catch((reason) => {
        if (!controller.signal.aborted && !isAbortError(reason)) {
          setError(errorMessage(reason, "Erro ao carregar clientes."));
        }
      });

    return () => controller.abort();
  }, [canManage]);

  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();

    void apiFetch<DetailResponse>(
      `/api/checkins/${encodeURIComponent(selectedId)}`,
      { signal: controller.signal }
    )
      .then((data) => setDetail(data.item))
      .catch((reason) => {
        if (!controller.signal.aborted && !isAbortError(reason)) {
          setDetail(null);
          setError(errorMessage(reason, "Erro ao carregar o check-in."));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingDetail(false);
      });

    return () => controller.abort();
  }, [loadDetail, selectedId]);

  const selectCheckin = (id: string) => {
    setLoadingDetail(true);
    setError(null);
    setMessage(null);
    setSelectedId(id);
  };

  const refresh = async () => {
    setError(null);
    setMessage(null);
    setLoadingList(true);
    try {
      await loadList();
      if (selectedId) await loadDetail(selectedId);
    } catch (reason) {
      setError(errorMessage(reason, "Erro ao atualizar a fila."));
    } finally {
      setLoadingList(false);
    }
  };

  const runManagerAction = async (action: CheckinManagerAction) => {
    if (!selectedId || !canManage) return;
    setError(null);
    setMessage(null);
    setActionPending(true);

    try {
      const basePath = `/api/checkins/${encodeURIComponent(selectedId)}`;
      if (action.kind === "ASSIGN_CLIENT") {
        await apiFetch(`${basePath}`, {
          method: "PATCH",
          body: JSON.stringify({
            action: "ASSIGN_CLIENT",
            clientId: action.clientId,
            expectedVersion: action.expectedVersion,
            reason: action.reason
          })
        });
      } else if (action.kind === "CORRECT") {
        await apiFetch(`${basePath}`, {
          method: "PATCH",
          body: JSON.stringify({
            action: "CORRECT",
            patch: action.patch,
            expectedVersion: action.expectedVersion,
            reason: action.reason
          })
        });
      } else if (action.kind === "TRANSITION") {
        await apiFetch(`${basePath}/transitions`, {
          method: "POST",
          body: JSON.stringify({
            toStatus: action.toStatus,
            expectedVersion: action.expectedVersion,
            reason: action.reason
          })
        });
      } else if (action.kind === "CANCEL") {
        await apiFetch(`${basePath}/cancel`, {
          method: "POST",
          body: JSON.stringify({
            expectedVersion: action.expectedVersion,
            reason: action.reason
          })
        });
      } else {
        await apiFetch(`${basePath}/location-override`, {
          method: "POST",
          body: JSON.stringify({
            expectedVersion: action.expectedVersion,
            justification: action.justification
          })
        });
      }

      await Promise.all([loadList(), loadDetail(selectedId)]);
      setMessage("Alteração registrada com auditoria.");
    } catch (reason) {
      setError(errorMessage(reason, "Não foi possível alterar o check-in."));
    } finally {
      setActionPending(false);
    }
  };

  return (
    <RoleGuard allowed={["OPERATOR", "SUPERVISOR", "ADMIN"]}>
      <section className="checkins-page space-y-4">
        <header className="checkins-hero">
          <div>
            <p className="checkins-eyebrow">Chegadas à Baixada Santista</p>
            <h1>Fila de check-ins</h1>
            <p>
              Acompanhe as visitas confirmadas. Esta lista não representa posição ou
              prioridade de descarga.
            </p>
          </div>
          <div className="checkins-total" aria-label={`${items.length} visitas carregadas`}>
            <strong>{items.length}</strong>
            <span>visitas</span>
          </div>
        </header>

        <div className="checkins-toolbar">
          <label>
            Buscar
            <input
              className="input-ui"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Placa, motorista, transportadora..."
              type="search"
              value={query}
            />
          </label>
          <label>
            Status
            <select
              className="select-ui"
              onChange={(event) =>
                setStatus(event.target.value as CheckinStatus | "")
              }
              value={status}
            >
              <option value="">Todos</option>
              {checkinStatusOptions.map((option) => (
                <option key={option} value={option}>
                  {statusLabel(option)}
                </option>
              ))}
            </select>
          </label>
          <button className="btn-soft" disabled={loadingList} onClick={() => void refresh()} type="button">
            {loadingList ? "Atualizando..." : "Atualizar fila"}
          </button>
        </div>

        {error ? (
          <div className="notice error" role="alert">
            {error}
          </div>
        ) : null}
        {message ? (
          <div className="notice success" role="status">
            {message}
          </div>
        ) : null}

        <div className="checkins-workbench">
          <section
            aria-busy={loadingList}
            aria-label="Visitas na fila"
            className="checkins-list"
          >
            {filteredItems.map((item) => (
              <button
                aria-pressed={selectedId === item.id}
                className={`checkin-card ${selectedId === item.id ? "active" : ""}`}
                key={item.id}
                onClick={() => selectCheckin(item.id)}
                type="button"
              >
                <div className="checkin-card-heading">
                  <span className={`checkin-status status-${item.status.toLowerCase()}`}>
                    {statusLabel(item.status)}
                  </span>
                  <strong>{item.plate}</strong>
                </div>
                <h2>{item.driverName}</h2>
                <p>{item.carrierName}</p>
                <dl>
                  <div>
                    <dt>Produto</dt>
                    <dd>{item.product}</dd>
                  </div>
                  <div>
                    <dt>Cliente</dt>
                    <dd>{item.clientName || "Não atribuído"}</dd>
                  </div>
                </dl>
              </button>
            ))}
            {loadingList ? <p className="checkins-empty">Carregando fila...</p> : null}
            {!loadingList && !filteredItems.length ? (
              <div className="checkins-empty">
                <strong>Nenhuma visita encontrada</strong>
                <span>Ajuste os filtros ou atualize a fila.</span>
              </div>
            ) : null}
          </section>

          <aside
            aria-busy={loadingDetail}
            aria-live="polite"
            className="checkins-detail"
          >
            <CheckinDetailPanel
              actionPending={actionPending}
              canManage={canManage}
              clients={clients}
              detail={detail}
              loading={loadingDetail}
              onAction={runManagerAction}
            />
          </aside>
        </div>
      </section>
    </RoleGuard>
  );
}
