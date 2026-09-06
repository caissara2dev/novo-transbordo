"use client";

import { Dispatch, FormEvent, SetStateAction } from "react";
import {
  categoryLabelMap,
  containerStatusLabelMap,
  containerStatusOptions,
  pumpOptions,
  reportCategoryOptions,
  shiftLabelMap,
  shiftOptions
} from "@/lib/domain/options";
import { EventListFilters } from "@/lib/ui/filters";
import { ClientApiItem, EventApiItem } from "@/types/api";
import {
  formatDuration,
  pumpShortLabel,
  toClockLabel,
  toViewDate,
  wasEdited
} from "./event-model";

type EventsHistoryProps = {
  clients: ClientApiItem[];
  events: EventApiItem[];
  draftFilters: EventListFilters;
  setDraftFilters: Dispatch<SetStateAction<EventListFilters>>;
  isManager: boolean;
  canRestore: boolean;
  loading: boolean;
  loadingMore: boolean;
  nextCursor: string | null;
  incomplete: boolean;
  onApplyFilters: (event: FormEvent) => void;
  onEdit: (item: EventApiItem) => void;
  onRestore: (eventId: string) => void;
  onDelete: (item: EventApiItem) => void;
  onLoadMore: () => void;
};

export function EventsHistory({
  clients,
  events,
  draftFilters,
  setDraftFilters,
  isManager,
  canRestore,
  loading,
  loadingMore,
  nextCursor,
  incomplete,
  onApplyFilters,
  onEdit,
  onRestore,
  onDelete,
  onLoadMore
}: EventsHistoryProps) {
  return (
    <section className="panel space-y-3">
      <h2 className="panel-title text-2xl">Histórico</h2>
      <form
        className="grid gap-3 md:grid-cols-4"
        onSubmit={onApplyFilters}
      >
        <label className="field-label">
          Data de
          <input
            className="input-ui"
            onChange={(event) =>
              setDraftFilters((current) => ({
                ...current,
                dateFrom: event.target.value
              }))
            }
            type="date"
            value={draftFilters.dateFrom}
          />
        </label>
        <label className="field-label">
          Data até
          <input
            className="input-ui"
            onChange={(event) =>
              setDraftFilters((current) => ({
                ...current,
                dateTo: event.target.value
              }))
            }
            type="date"
            value={draftFilters.dateTo}
          />
        </label>
        <label className="field-label">
          Bomba
          <select
            className="select-ui"
            onChange={(event) =>
              setDraftFilters((current) => ({
                ...current,
                pump: event.target.value
              }))
            }
            value={draftFilters.pump}
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
            onChange={(event) =>
              setDraftFilters((current) => ({
                ...current,
                shiftType: event.target.value
              }))
            }
            value={draftFilters.shiftType}
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
            onChange={(event) =>
              setDraftFilters((current) => ({
                ...current,
                category: event.target.value
              }))
            }
            value={draftFilters.category}
          >
            <option value="">Todas</option>
            {reportCategoryOptions.map((category) => (
              <option key={category.value} value={category.value}>
                {category.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field-label">
          Cliente
          <select
            className="select-ui"
            onChange={(event) =>
              setDraftFilters((current) => ({
                ...current,
                clientId: event.target.value
              }))
            }
            value={draftFilters.clientId}
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
            onChange={(event) =>
              setDraftFilters((current) => ({
                ...current,
                containerStatus: event.target.value
              }))
            }
            value={draftFilters.containerStatus}
          >
            <option value="">Todos</option>
            {containerStatusOptions.map((status) => (
              <option key={status.value} value={status.value}>
                {status.label}
              </option>
            ))}
          </select>
        </label>

        {isManager ? (
          <label className="mt-7 flex items-center gap-2 text-sm muted">
            <input
              checked={draftFilters.includeDeleted}
              onChange={(event) =>
                setDraftFilters((current) => ({
                  ...current,
                  includeDeleted: event.target.checked
                }))
              }
              type="checkbox"
            />
            Incluir excluídos
          </label>
        ) : null}

        <button className="btn-primary md:mt-7" type="submit">
          Aplicar filtros
        </button>
      </form>

      <div className="history-stack">
        {events.map((item) => (
          <article
            className={`history-item ${
              item.deleted ? "is-deleted" : ""
            }`}
            key={item.id}
          >
            <div className="history-head">
              <div>
                <p className="history-title">
                  {item.shiftDate} • {shiftLabelMap[item.shiftType]} •{" "}
                  {pumpShortLabel(item.pump)} •{" "}
                  {categoryLabelMap[item.category]}
                  {(item.origin || "MANUAL") === "AUTO_GAP" ? (
                    <span className="ml-2 inline-flex rounded-full border border-teal-300 bg-teal-50 px-2 py-0.5 text-[0.68rem] font-extrabold uppercase tracking-wide text-teal-800">
                      Automático
                    </span>
                  ) : null}
                </p>
                <p className="history-time">
                  {toClockLabel(item.startTime)} →{" "}
                  {toClockLabel(item.endTime)}
                </p>
              </div>
              <div className="history-top-right">
                <p className="history-duration">
                  {formatDuration(item.durationMinutes)}
                </p>
                {isManager && !item.deleted ? (
                  <button
                    className="history-edit-btn"
                    onClick={() => onEdit(item)}
                    type="button"
                  >
                    Editar
                  </button>
                ) : null}
                {item.deleted &&
                canRestore &&
                (item.origin || "MANUAL") !== "AUTO_GAP" ? (
                  <button
                    className="history-edit-btn"
                    disabled={loading}
                    onClick={() => onRestore(item.id)}
                    type="button"
                  >
                    Restaurar
                  </button>
                ) : null}
              </div>
            </div>
            <p className="history-mainline">
              <strong>Cliente:</strong> {item.clientNameSnapshot || "-"} •{" "}
              <strong>Obs:</strong> {item.notes || "-"}
            </p>
            {item.containerStatus ? (
              <div className="container-history-summary">
                <span
                  className={`container-status-badge status-${item.containerStatus.toLowerCase()}`}
                >
                  {containerStatusLabelMap[item.containerStatus]}
                </span>
                {item.containerReason ? (
                  <span>Motivo: {item.containerReason}</span>
                ) : null}
              </div>
            ) : null}
            <p className="history-meta">
              {item.loadSourceType === "BUFFER_CONTAINER" ? (
                <>
                  <strong>Container de origem:</strong>{" "}
                  {item.sourceContainer || "-"} •{" "}
                  <strong>Container de destino:</strong>{" "}
                  {item.container || "-"}
                </>
              ) : (
                <>
                  <strong>Placa:</strong> {item.plate || "-"} •{" "}
                  <strong>Container:</strong> {item.container || "-"}
                </>
              )}
            </p>
            {item.loadSourceType === "BUFFER_CONTAINER" ? (
              <p className="history-meta">
                Container de origem{" "}
                {item.sourceContainerEmptied
                  ? "esvaziado pela transferência"
                  : "com carga remanescente"}
                .
              </p>
            ) : null}
            <p className="history-meta">
              Criado por: {item.createdByEmail}
            </p>
            {item.previousContainerPassages?.length ? (
              <details className="container-history-details">
                <summary>
                  Ver passagens anteriores (
                  {item.previousContainerPassages.length})
                </summary>
                <ol className="container-cycle-passages">
                  {item.previousContainerPassages.map((passage, index) => (
                    <li key={passage.id}>
                      <span className="container-passage-index">
                        {index + 1}ª passagem
                      </span>
                      <span>
                        {toClockLabel(passage.startTime)}–
                        {toClockLabel(passage.endTime)}
                      </span>
                      <span>{pumpShortLabel(passage.pump)}</span>
                      <span>
                        {passage.relatedContainer
                          ? `${passage.role === "SOURCE" ? "Destino" : "Origem"}: ${passage.relatedContainer}`
                          : passage.plate || "Sem placa"}
                      </span>
                      <span
                        className={`container-status-badge status-${passage.status.toLowerCase()}`}
                      >
                        {containerStatusLabelMap[passage.status]}
                      </span>
                    </li>
                  ))}
                </ol>
              </details>
            ) : null}
            {wasEdited(item) ? (
              <p className="history-meta">
                Editado em: {toViewDate(item.updatedAt)} (
                {item.updatedByEmail})
              </p>
            ) : null}
            {item.deleted ? (
              <p className="notice error mt-2">
                Excluído: {item.deletedReason || "-"} (
                {item.deletedByEmail || "-"})
              </p>
            ) : null}

            {isManager &&
            !item.deleted &&
            (item.origin || "MANUAL") !== "AUTO_GAP" ? (
              <div className="history-actions">
                <button
                  className="btn-danger"
                  onClick={() => onDelete(item)}
                  type="button"
                >
                  Excluir
                </button>
              </div>
            ) : null}
          </article>
        ))}

        {!events.length ? (
          <p className="text-sm muted">Nenhum lançamento encontrado.</p>
        ) : null}
      </div>

      {incomplete ? (
        <p className="notice warn">
          A consulta atingiu o limite de varredura. Refine os filtros ou
          carregue a próxima página para continuar.
        </p>
      ) : null}

      {nextCursor ? (
        <div className="flex justify-center">
          <button
            className="btn-soft"
            disabled={loadingMore}
            onClick={onLoadMore}
            type="button"
          >
            {loadingMore ? "Carregando…" : "Carregar mais"}
          </button>
        </div>
      ) : null}
    </section>
  );
}
