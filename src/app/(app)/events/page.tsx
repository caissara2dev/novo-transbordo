"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { categoryRules } from "@/lib/domain/constants";
import { computeWindowCheck, currentShiftFromNow } from "@/lib/domain/time";
import { formatContainerForInput, formatPlateForInput } from "@/lib/domain/identifiers";
import { apiFetch } from "@/lib/auth/api-fetch";
import { useAuthSession } from "@/lib/auth/use-auth-session";
import {
  categoryLabelMap,
  categoryOptions,
  pumpOptions,
  shiftLabelMap,
  shiftOptions
} from "@/lib/domain/options";
import { Category, Pump, ShiftType } from "@/types/domain";
import { ClientApiItem, EventApiItem } from "@/types/api";

type EventFormState = {
  pump: Pump;
  shiftDate: string;
  shiftType: ShiftType;
  startTime: string;
  endTime: string;
  category: Category;
  clientId: string;
  plate: string;
  container: string;
  notes: string;
  revisionReason?: string;
};

const shiftNow = currentShiftFromNow();
const categoryDescriptions: Record<Category, string> = {
  PRODUTIVO: "Transbordo em execução.",
  EM_TRANSITO: "Movimentação entre pontos.",
  AGUARDANDO_LABORATORIO: "Parado aguardando liberação.",
  SEM_CAMINHAO: "Sem veículo disponível.",
  SEM_CONTAINER: "Sem container para operação.",
  MANUTENCAO: "Parada para manutenção.",
  OUTROS: "Ocorrências fora dos cenários acima."
};

function makeInitialForm(): EventFormState {
  return {
    pump: "BOMBA_1",
    shiftDate: shiftNow.shiftDate,
    shiftType: shiftNow.shiftType,
    startTime: "",
    endTime: "",
    category: "PRODUTIVO",
    clientId: "",
    plate: "",
    container: "",
    notes: ""
  };
}

function toPayload(form: EventFormState) {
  return {
    pump: form.pump,
    shiftDate: form.shiftDate,
    shiftType: form.shiftType,
    startTime: form.startTime,
    endTime: form.endTime,
    category: form.category,
    clientId: form.clientId || null,
    plate: form.plate || null,
    container: form.container || null,
    notes: form.notes || null,
    revisionReason: form.revisionReason || null
  };
}

function toViewDate(iso: string): string {
  if (!iso) {
    return "-";
  }

  return new Date(iso).toLocaleString("pt-BR");
}

function formatDuration(durationMinutes: number): string {
  const hours = Math.floor(durationMinutes / 60);
  const minutes = durationMinutes % 60;

  if (hours && minutes) {
    return `${hours}h ${minutes}m`;
  }

  if (hours) {
    return `${hours}h`;
  }

  return `${minutes}m`;
}

function pumpShortLabel(pump: Pump): string {
  return pump === "BOMBA_1" ? "B1" : "B2";
}

function toClockLabel(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const date = new Date(2000, 0, 1, h, m);
  return date.toLocaleTimeString("pt-BR", {
    hour: "numeric",
    minute: "2-digit"
  });
}

function wasEdited(item: EventApiItem): boolean {
  const createdMs = Date.parse(item.createdAt);
  const updatedMs = Date.parse(item.updatedAt);

  if (Number.isFinite(createdMs) && Number.isFinite(updatedMs)) {
    return updatedMs > createdMs;
  }

  return item.updatedAt !== item.createdAt;
}

function EventFormFields({
  form,
  setForm,
  clients,
  submitLabel,
  onSubmit,
  loading
}: {
  form: EventFormState;
  setForm: (next: EventFormState) => void;
  clients: ClientApiItem[];
  submitLabel: string;
  onSubmit: (e: FormEvent) => Promise<void>;
  loading: boolean;
}) {
  const rules = categoryRules[form.category];

  const warningStart = form.startTime
    ? !computeWindowCheck(form.shiftType, form.startTime)
    : false;
  const warningEnd = form.endTime ? !computeWindowCheck(form.shiftType, form.endTime) : false;

  return (
    <form className="grid grid-cols-2 gap-3" onSubmit={onSubmit}>
      <div className="field-label col-span-2">
        Bomba
        <div className="choice-grid">
          {pumpOptions.map((pump) => (
            <button
              className={`choice-card ${form.pump === pump.value ? "active" : ""}`}
              key={pump.value}
              onClick={() => setForm({ ...form, pump: pump.value })}
              type="button"
            >
              {pump.label}
            </button>
          ))}
        </div>
      </div>

      <label className="field-label">
        Data do turno
        <input
          className="input-ui"
          onChange={(e) => setForm({ ...form, shiftDate: e.target.value })}
          required
          type="date"
          value={form.shiftDate}
        />
      </label>

      <label className="field-label">
        Turno
        <select
          className="select-ui"
          onChange={(e) => setForm({ ...form, shiftType: e.target.value as ShiftType })}
          value={form.shiftType}
        >
          {shiftOptions.map((shift) => (
            <option key={shift.value} value={shift.value}>
              {shift.label}
            </option>
          ))}
        </select>
      </label>

      <label className="field-label">
        Horário início
        <input
          className="input-ui"
          onChange={(e) => setForm({ ...form, startTime: e.target.value })}
          required
          type="time"
          value={form.startTime}
        />
        {warningStart ? (
          <span className="notice warn mt-1 block normal-case">
            Aviso: horário fora da janela do turno selecionado.
          </span>
        ) : null}
      </label>

      <label className="field-label">
        Horário fim
        <input
          className="input-ui"
          onChange={(e) => setForm({ ...form, endTime: e.target.value })}
          required
          type="time"
          value={form.endTime}
        />
        {warningEnd ? (
          <span className="notice warn mt-1 block normal-case">
            Aviso: horário fora da janela do turno selecionado.
          </span>
        ) : null}
      </label>

      <div className="field-label col-span-2">
        Categoria
        <div className="choice-grid category-grid">
          {categoryOptions.map((cat) => (
            <button
              className={`choice-card ${form.category === cat.value ? "active" : ""}`}
              key={cat.value}
              onClick={() => setForm({ ...form, category: cat.value as Category })}
              type="button"
            >
              {cat.label}
              <span className="choice-card-detail">{categoryDescriptions[cat.value]}</span>
            </button>
          ))}
        </div>
      </div>

      <label className="field-label col-span-2">
        Cliente {rules.requiresClient ? "*" : ""}
        <select
          className="select-ui"
          onChange={(e) => setForm({ ...form, clientId: e.target.value })}
          required={rules.requiresClient}
          value={form.clientId}
        >
          <option value="">Selecione</option>
          {clients.map((client) => (
            <option key={client.id} value={client.id}>
              {client.name}
            </option>
          ))}
        </select>
      </label>

      <label className="field-label">
        Placa {rules.requiresPlate ? "*" : ""}
        <input
          className="input-ui"
          onChange={(e) => setForm({ ...form, plate: formatPlateForInput(e.target.value) })}
          placeholder="AAA1234 ou AAA1A23"
          required={rules.requiresPlate}
          type="text"
          value={form.plate}
        />
      </label>

      <label className="field-label">
        Container {rules.requiresContainer ? "*" : ""}
        <input
          className="input-ui"
          onChange={(e) => setForm({ ...form, container: formatContainerForInput(e.target.value) })}
          placeholder="ABCU1234560"
          required={rules.requiresContainer}
          type="text"
          value={form.container}
        />
      </label>

      <label className="field-label col-span-2">
        Observações {rules.requiresNotes ? "*" : ""}
        <textarea
          className="textarea-ui h-24"
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
          required={rules.requiresNotes}
          value={form.notes}
        />
      </label>

      <button className="btn-primary col-span-2 w-full" disabled={loading} type="submit">
        {loading ? "Salvando..." : submitLabel}
      </button>
    </form>
  );
}

export default function EventsPage() {
  const { profile } = useAuthSession();
  const [clients, setClients] = useState<ClientApiItem[]>([]);
  const [events, setEvents] = useState<EventApiItem[]>([]);
  const [form, setForm] = useState<EventFormState>(makeInitialForm());
  const [editForm, setEditForm] = useState<EventFormState | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [filters, setFilters] = useState({
    dateFrom: shiftNow.shiftDate,
    dateTo: shiftNow.shiftDate,
    pump: "",
    shiftType: "",
    category: "",
    clientId: "",
    includeDeleted: false
  });
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isManager = useMemo(
    () => profile?.role === "SUPERVISOR" || profile?.role === "ADMIN",
    [profile?.role]
  );

  const canRestore = profile?.role === "ADMIN";

  const loadClients = useCallback(async () => {
    const data = await apiFetch<{ items: ClientApiItem[] }>("/api/clients");
    setClients(data.items || []);
  }, []);

  const loadEvents = useCallback(async () => {
    const query = new URLSearchParams();
    if (filters.dateFrom) query.set("dateFrom", filters.dateFrom);
    if (filters.dateTo) query.set("dateTo", filters.dateTo);
    if (filters.pump) query.set("pump", filters.pump);
    if (filters.shiftType) query.set("shiftType", filters.shiftType);
    if (filters.category) query.set("category", filters.category);
    if (filters.clientId) query.set("clientId", filters.clientId);
    if (filters.includeDeleted) query.set("includeDeleted", "true");

    const data = await apiFetch<{ items: EventApiItem[] }>(`/api/events?${query.toString()}`);
    setEvents(data.items || []);
  }, [filters]);

  useEffect(() => {
    if (!profile?.approved) {
      return;
    }

    loadClients().catch((err) => setError(err.message));
    loadEvents().catch((err) => setError(err.message));
  }, [profile?.approved, loadClients, loadEvents]);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);

    try {
      const response = await apiFetch<{ item: EventApiItem }>("/api/events", {
        method: "POST",
        body: JSON.stringify(toPayload(form))
      });

      setMessage(
        response.item.warnings?.length
          ? `Lançamento salvo com avisos: ${response.item.warnings.join(" | ")}`
          : "Lançamento salvo com sucesso."
      );
      setForm(makeInitialForm());
      await loadEvents();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao salvar lançamento.");
    } finally {
      setLoading(false);
    }
  };

  const startEdit = (item: EventApiItem) => {
    setEditId(item.id);
    setEditForm({
      pump: item.pump,
      shiftDate: item.shiftDate,
      shiftType: item.shiftType,
      startTime: item.startTime,
      endTime: item.endTime,
      category: item.category,
      clientId: item.clientId || "",
      plate: item.plate || "",
      container: item.container || "",
      notes: item.notes || "",
      revisionReason: ""
    });
  };

  const handleEdit = async (e: FormEvent) => {
    e.preventDefault();
    if (!editId || !editForm) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await apiFetch<{ item: EventApiItem }>(`/api/events/${editId}`, {
        method: "PATCH",
        body: JSON.stringify(toPayload(editForm))
      });

      setMessage(
        response.item.warnings?.length
          ? `Edição salva com avisos: ${response.item.warnings.join(" | ")}`
          : "Lançamento atualizado com sucesso."
      );
      setEditId(null);
      setEditForm(null);
      await loadEvents();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao editar lançamento.");
    } finally {
      setLoading(false);
    }
  };

  const deleteEvent = async (eventId: string) => {
    const reason = window.prompt("Informe o motivo da exclusão:");

    if (!reason) {
      return;
    }

    try {
      await apiFetch(`/api/events/${eventId}`, {
        method: "DELETE",
        body: JSON.stringify({ reason })
      });

      setMessage("Lançamento excluído com sucesso.");
      await loadEvents();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao excluir lançamento.");
    }
  };

  const restoreEvent = async (eventId: string) => {
    try {
      await apiFetch(`/api/events/${eventId}/restore`, {
        method: "POST"
      });

      setMessage("Lançamento restaurado.");
      await loadEvents();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao restaurar lançamento.");
    }
  };

  return (
    <section className="space-y-6">
      {error ? <div className="notice error">{error}</div> : null}
      {message ? <div className="notice success">{message}</div> : null}

      <section className="panel space-y-3">
        <h2 className="panel-title text-2xl">Novo lançamento</h2>
        <EventFormFields
          clients={clients}
          form={form}
          loading={loading}
          onSubmit={handleCreate}
          setForm={(next) => setForm(next)}
          submitLabel="Salvar lançamento"
        />
      </section>

      {editForm ? (
        <div className="panel border-amber-300 bg-amber-50/70">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="panel-title text-2xl">Editar lançamento</h2>
            <button
              className="btn-soft"
              onClick={() => {
                setEditId(null);
                setEditForm(null);
              }}
              type="button"
            >
              Cancelar
            </button>
          </div>
          <label className="field-label mb-3 block">
            Justificativa da edição (opcional)
            <input
              className="input-ui"
              onChange={(e) => setEditForm({ ...editForm, revisionReason: e.target.value })}
              type="text"
              value={editForm.revisionReason || ""}
            />
          </label>
          <EventFormFields
            clients={clients}
            form={editForm}
            loading={loading}
            onSubmit={handleEdit}
            setForm={(next) => setEditForm(next)}
            submitLabel="Salvar edição"
          />
        </div>
      ) : null}

      <section className="panel space-y-3">
        <h2 className="panel-title text-2xl">Histórico</h2>
        <form
          className="grid gap-3 md:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            loadEvents().catch((err) => setError(err.message));
          }}
        >
          <label className="field-label">
            Data de
            <input
              className="input-ui"
              onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value })}
              type="date"
              value={filters.dateFrom}
            />
          </label>
          <label className="field-label">
            Data até
            <input
              className="input-ui"
              onChange={(e) => setFilters({ ...filters, dateTo: e.target.value })}
              type="date"
              value={filters.dateTo}
            />
          </label>
          <label className="field-label">
            Bomba
            <select
              className="select-ui"
              onChange={(e) => setFilters({ ...filters, pump: e.target.value })}
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
              onChange={(e) => setFilters({ ...filters, shiftType: e.target.value })}
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
              onChange={(e) => setFilters({ ...filters, category: e.target.value })}
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
              onChange={(e) => setFilters({ ...filters, clientId: e.target.value })}
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

          {isManager ? (
            <label className="mt-7 flex items-center gap-2 text-sm muted">
              <input
                checked={filters.includeDeleted}
                onChange={(e) => setFilters({ ...filters, includeDeleted: e.target.checked })}
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
            <article className={`history-item ${item.deleted ? "is-deleted" : ""}`} key={item.id}>
              <div className="history-head">
                <div>
                  <p className="history-title">
                    {item.shiftDate} • {shiftLabelMap[item.shiftType]} • {pumpShortLabel(item.pump)} •{" "}
                    {categoryLabelMap[item.category]}
                  </p>
                  <p className="history-time">
                    {toClockLabel(item.startTime)} → {toClockLabel(item.endTime)}
                  </p>
                </div>
                <div className="history-top-right">
                  <p className="history-duration">{formatDuration(item.durationMinutes)}</p>
                  {isManager && !item.deleted ? (
                    <button className="history-edit-btn" onClick={() => startEdit(item)} type="button">
                      Editar
                    </button>
                  ) : null}
                  {item.deleted && canRestore ? (
                    <button className="history-edit-btn" onClick={() => restoreEvent(item.id)} type="button">
                      Restaurar
                    </button>
                  ) : null}
                </div>
              </div>
              <p className="history-mainline">
                <strong>Cliente:</strong> {item.clientNameSnapshot || "-"} • <strong>Obs:</strong>{" "}
                {item.notes || "-"}
              </p>
              <p className="history-meta">
                <strong>Placa:</strong> {item.plate || "-"} • <strong>Container:</strong>{" "}
                {item.container || "-"}
              </p>
              <p className="history-meta">Criado por: {item.createdByEmail}</p>
              {wasEdited(item) ? (
                <p className="history-meta">
                  Editado em: {toViewDate(item.updatedAt)} ({item.updatedByEmail})
                </p>
              ) : null}
              {item.deleted ? (
                <p className="notice error mt-2">
                  Excluído: {item.deletedReason || "-"} ({item.deletedByEmail || "-"})
                </p>
              ) : null}

              {isManager && !item.deleted ? (
                <div className="history-actions">
                  <button className="btn-danger" onClick={() => deleteEvent(item.id)} type="button">
                    Excluir
                  </button>
                </div>
              ) : null}
            </article>
          ))}

          {!events.length ? <p className="text-sm muted">Nenhum lançamento encontrado.</p> : null}
        </div>
      </section>
    </section>
  );
}
