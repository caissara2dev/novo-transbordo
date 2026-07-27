"use client";

import {
  Dispatch,
  FormEvent,
  SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useState
} from "react";
import { categoryRules } from "@/lib/domain/constants";
import { computeWindowCheck, currentShiftFromNow } from "@/lib/domain/time";
import { formatContainerForInput, formatPlateForInput } from "@/lib/domain/identifiers";
import { apiFetch } from "@/lib/auth/api-fetch";
import { useAuthSession } from "@/lib/auth/use-auth-session";
import { ContainerStatusFields } from "@/components/container-status-fields";
import {
  categoryLabelMap,
  containerStatusLabelMap,
  containerStatusOptions,
  idleCategoryOptions,
  pumpOptions,
  reportCategoryOptions,
  pumpShortLabelMap,
  shiftLabelMap,
  shiftOptions
} from "@/lib/domain/options";
import {
  Category,
  ContainerStatus,
  GapJustification,
  GapPreview,
  Pump,
  ShiftType
} from "@/types/domain";
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
  containerStatus: ContainerStatus | null;
  containerReason: string;
  startsNewContainerCycle: boolean;
  blendConfirmed: boolean;
  expectedContainerStateVersion: number | null;
  notes: string;
  revisionReason?: string;
  gapPreview: GapPreview | null;
  gapJustifications: GapJustification[];
};

type DeletePlan = {
  eventId: string;
  reason: string;
  preview: GapPreview;
  gapJustifications: GapJustification[];
};

const shiftNow = currentShiftFromNow();
const categoryDescriptions: Record<Category, string> = {
  PRODUTIVO: "Transbordo em execução.",
  INTERVALO_OPERACIONAL: "Intervalo gerado automaticamente.",
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
    containerStatus: "FULL",
    containerReason: "",
    startsNewContainerCycle: false,
    blendConfirmed: false,
    expectedContainerStateVersion: null,
    notes: "",
    gapPreview: null,
    gapJustifications: []
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
    containerStatus: form.category === "PRODUTIVO" ? form.containerStatus || "FULL" : null,
    containerReason: form.containerReason || null,
    startsNewContainerCycle: form.startsNewContainerCycle,
    blendConfirmed: form.blendConfirmed,
    expectedContainerStateVersion: form.expectedContainerStateVersion,
    notes: form.notes || null,
    revisionReason: form.revisionReason || null,
    gapVersion: form.gapPreview?.gapVersion || null,
    gapJustifications: form.gapJustifications
  };
}

function useGapPreview<T extends EventFormState | null>(
  form: T,
  setForm: Dispatch<SetStateAction<T>>,
  eventId?: string | null
) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pump = form?.pump;
  const shiftDate = form?.shiftDate;
  const shiftType = form?.shiftType;
  const startTime = form?.startTime;
  const endTime = form?.endTime;
  const category = form?.category;

  useEffect(() => {
    if (category !== "PRODUTIVO" || !startTime || !shiftDate || !pump || !shiftType) {
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const preview = await apiFetch<GapPreview>("/api/events/gap-preview", {
          method: "POST",
          body: JSON.stringify({
            pump,
            shiftDate,
            shiftType,
            startTime,
            endTime: endTime || undefined,
            eventId: eventId || undefined
          }),
          signal: controller.signal
        });
        setForm((current) => {
          if (!current) return current;
          const previous = new Map(current.gapJustifications.map((item) => [item.id, item]));
          const gapJustifications = preview.requiresJustification
            ? preview.uncoveredSegments.map((segment) => previous.get(segment.id) || {
                ...segment,
                category: "OUTROS",
                clientId: null,
                plate: null,
                notes: null
              })
            : [];
          return { ...current, gapPreview: preview, gapJustifications } as T;
        });
      } catch (reason) {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : "Falha ao calcular o intervalo.");
          setForm((current) => current ? { ...current, gapPreview: null } as T : current);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 350);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [category, endTime, eventId, pump, setForm, shiftDate, shiftType, startTime]);

  return { loading, error };
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
  return pumpShortLabelMap[pump];
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

function GapPanel({
  form,
  setForm,
  clients,
  gapState
}: {
  form: EventFormState;
  setForm: Dispatch<SetStateAction<EventFormState>>;
  clients: ClientApiItem[];
  gapState: { loading: boolean; error: string | null };
}) {
  const preview = form.gapPreview;
  const patchJustification = (id: string, patch: Partial<GapJustification>) => {
    setForm((current) => ({
      ...current,
      gapJustifications: current.gapJustifications.map((item) =>
        item.id === id ? { ...item, ...patch } : item
      )
    }));
  };

  if (gapState.loading) {
    return (
      <div className="notice col-span-2 border-slate-200 bg-slate-50 text-slate-600">
        Verificando a linha do tempo da bomba…
      </div>
    );
  }
  if (gapState.error) {
    return <div className="notice error col-span-2">{gapState.error}</div>;
  }
  if (!form.startTime || !preview) return null;
  if (!preview.uncoveredSegments.length) {
    return (
      <div className="notice success col-span-2">
        Linha do tempo contínua. Nenhuma ociosidade será criada.
      </div>
    );
  }
  if (!preview.requiresJustification) {
    return (
      <div className="notice success col-span-2">
        <strong>{formatDuration(preview.uncoveredMinutes)}</strong> de intervalo serão registrados
        automaticamente como <strong>Intervalo operacional</strong>. O limite sem justificativa é
        de {preview.toleranceMinutes} min.
      </div>
    );
  }

  return (
    <section className="col-span-2 space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-3">
      <div>
        <h3 className="text-base font-extrabold text-amber-950">Justificativa obrigatória</h3>
        <p className="text-sm text-amber-900">
          Há {formatDuration(preview.uncoveredMinutes)} sem cobertura. Informe uma causa para cada
          trecho antes de salvar.
        </p>
      </div>
      {form.gapJustifications.map((item, index) => {
        const rules = categoryRules[item.category];
        return (
          <fieldset className="grid grid-cols-2 gap-3 rounded-xl border border-amber-200 bg-white p-3" key={item.id}>
            <legend className="px-2 text-sm font-extrabold text-slate-700">
              Trecho {index + 1}: {item.startTime}–{item.endTime} ({item.durationMinutes} min)
            </legend>
            <label className="field-label col-span-2">
              Causa
              <select
                className="select-ui"
                onChange={(e) =>
                  patchJustification(item.id, {
                    category: e.target.value as GapJustification["category"],
                    clientId: null,
                    plate: null,
                    notes: null
                  })
                }
                value={item.category}
              >
                {idleCategoryOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            {rules.requiresClient ? (
              <label className="field-label col-span-2">
                Cliente *
                <select
                  className="select-ui"
                  onChange={(e) => patchJustification(item.id, { clientId: e.target.value || null })}
                  required
                  value={item.clientId || ""}
                >
                  <option value="">Selecione</option>
                  {clients.map((client) => (
                    <option key={client.id} value={client.id}>{client.name}</option>
                  ))}
                </select>
              </label>
            ) : null}
            {rules.requiresPlate ? (
              <label className="field-label col-span-2 md:col-span-1">
                Placa *
                <input
                  className="input-ui"
                  onChange={(e) =>
                    patchJustification(item.id, { plate: formatPlateForInput(e.target.value) || null })
                  }
                  required
                  value={item.plate || ""}
                />
              </label>
            ) : null}
            {rules.requiresNotes ? (
              <label className={`field-label ${rules.requiresPlate ? "md:col-span-1" : "col-span-2"}`}>
                Observação *
                <textarea
                  className="textarea-ui"
                  onChange={(e) => patchJustification(item.id, { notes: e.target.value || null })}
                  required
                  value={item.notes || ""}
                />
              </label>
            ) : null}
          </fieldset>
        );
      })}
    </section>
  );
}

function DeleteReconciliationPanel({
  plan,
  clients,
  loading,
  onChange,
  onCancel,
  onConfirm
}: {
  plan: DeletePlan;
  clients: ClientApiItem[];
  loading: boolean;
  onChange: (next: DeletePlan) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const patch = (id: string, change: Partial<GapJustification>) => {
    onChange({
      ...plan,
      gapJustifications: plan.gapJustifications.map((item) =>
        item.id === id ? { ...item, ...change } : item
      )
    });
  };

  return (
    <section className="panel space-y-3 border-amber-300 bg-amber-50">
      <div>
        <p className="text-xs font-extrabold uppercase tracking-[0.16em] text-amber-800">
          Recalcular após exclusão
        </p>
        <h2 className="panel-title mt-1">Justifique os novos intervalos</h2>
        <p className="mt-1 text-sm text-amber-950">
          Excluir este produtivo abrirá {formatDuration(plan.preview.uncoveredMinutes)} antes do
          próximo lançamento. Informe uma causa para cada trecho.
        </p>
      </div>
      {plan.gapJustifications.map((item, index) => {
        const rules = categoryRules[item.category];
        return (
          <fieldset className="grid grid-cols-2 gap-3 rounded-xl border border-amber-200 bg-white p-3" key={item.id}>
            <legend className="px-2 text-sm font-extrabold">
              Trecho {index + 1}: {item.startTime}–{item.endTime} ({item.durationMinutes} min)
            </legend>
            <label className="field-label col-span-2">
              Causa
              <select
                className="select-ui"
                onChange={(event) =>
                  patch(item.id, {
                    category: event.target.value as GapJustification["category"],
                    clientId: null,
                    plate: null,
                    notes: null
                  })
                }
                value={item.category}
              >
                {idleCategoryOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            {rules.requiresClient ? (
              <label className="field-label col-span-2">
                Cliente *
                <select
                  className="select-ui"
                  onChange={(event) => patch(item.id, { clientId: event.target.value || null })}
                  required
                  value={item.clientId || ""}
                >
                  <option value="">Selecione</option>
                  {clients.map((client) => (
                    <option key={client.id} value={client.id}>{client.name}</option>
                  ))}
                </select>
              </label>
            ) : null}
            {rules.requiresPlate ? (
              <label className="field-label">
                Placa *
                <input
                  className="input-ui"
                  onChange={(event) =>
                    patch(item.id, { plate: formatPlateForInput(event.target.value) || null })
                  }
                  required
                  value={item.plate || ""}
                />
              </label>
            ) : null}
            {rules.requiresNotes ? (
              <label className={`field-label ${rules.requiresPlate ? "" : "col-span-2"}`}>
                Observação *
                <textarea
                  className="textarea-ui"
                  onChange={(event) => patch(item.id, { notes: event.target.value || null })}
                  required
                  value={item.notes || ""}
                />
              </label>
            ) : null}
          </fieldset>
        );
      })}
      <div className="flex justify-end gap-2">
        <button className="btn-soft" disabled={loading} onClick={onCancel} type="button">
          Cancelar
        </button>
        <button className="btn-danger" disabled={loading} onClick={onConfirm} type="button">
          {loading ? "Excluindo…" : "Confirmar exclusão e recalcular"}
        </button>
      </div>
    </section>
  );
}

function EventFormFields({
  form,
  setForm,
  clients,
  submitLabel,
  onSubmit,
  loading,
  isEditing = false,
  isAutomatic = false,
  gapState
}: {
  form: EventFormState;
  setForm: Dispatch<SetStateAction<EventFormState>>;
  clients: ClientApiItem[];
  submitLabel: string;
  onSubmit: (e: FormEvent) => Promise<void>;
  loading: boolean;
  isEditing?: boolean;
  isAutomatic?: boolean;
  gapState: { loading: boolean; error: string | null };
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
              disabled={isAutomatic}
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
          disabled={isAutomatic}
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
          disabled={isAutomatic}
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
          disabled={isAutomatic}
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
          disabled={isAutomatic}
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

      <div className="col-span-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
        <div>
          <p className="text-sm font-extrabold text-slate-700">
            {form.category === "PRODUTIVO" ? "Lançamento produtivo" : "Ociosidade manual"}
          </p>
          <p className="text-xs text-slate-500">
            {form.category === "PRODUTIVO"
              ? "Os intervalos anteriores serão calculados automaticamente."
              : "Use este modo somente para registrar uma ocorrência manual."}
          </p>
        </div>
        {!isAutomatic ? (
          <button
            className="btn-soft"
            onClick={() =>
              setForm({
                ...form,
                category: form.category === "PRODUTIVO" ? "OUTROS" : "PRODUTIVO",
                containerStatus: form.category === "PRODUTIVO" ? null : form.containerStatus || "FULL",
                gapPreview: null,
                gapJustifications: []
              })
            }
            type="button"
          >
            {form.category === "PRODUTIVO" ? "Registrar ociosidade" : "Voltar ao produtivo"}
          </button>
        ) : (
          <span className="pill">Horários derivados</span>
        )}
      </div>

      {form.category !== "PRODUTIVO" ? (
        <div className="field-label col-span-2">
          Causa da ociosidade
          <div className="choice-grid category-grid">
          {idleCategoryOptions.map((cat) => (
            <button
              className={`choice-card ${form.category === cat.value ? "active" : ""}`}
              key={cat.value}
              onClick={() =>
                setForm({
                  ...form,
                  category: cat.value,
                  containerStatus: null,
                  containerReason: "",
                  startsNewContainerCycle: false,
                  blendConfirmed: false,
                  expectedContainerStateVersion: null
                })
              }
              type="button"
            >
              {cat.label}
              <span className="choice-card-detail">{categoryDescriptions[cat.value]}</span>
            </button>
          ))}
          </div>
        </div>
      ) : null}

      {form.category === "PRODUTIVO" ? (
        <GapPanel
          clients={clients}
          form={form}
          gapState={gapState}
          setForm={setForm}
        />
      ) : null}

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
          onChange={(e) =>
            setForm({
              ...form,
              container: formatContainerForInput(e.target.value),
              expectedContainerStateVersion: null,
              startsNewContainerCycle: false,
              blendConfirmed: false
            })
          }
          placeholder="ABCU1234560"
          required={rules.requiresContainer}
          type="text"
          value={form.container}
        />
      </label>

      <ContainerStatusFields
        fields={form}
        onChange={(patch) => setForm({ ...form, ...patch })}
        preserveStatus={isEditing}
      />

      <label className="field-label col-span-2">
        Observações {rules.requiresNotes ? "*" : ""}
        <textarea
          className="textarea-ui h-24"
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
          required={rules.requiresNotes}
          value={form.notes}
        />
      </label>

      <button
        className="btn-primary col-span-2 w-full"
        disabled={
          loading ||
          gapState.loading ||
          Boolean(form.category === "PRODUTIVO" && form.startTime && !form.gapPreview)
        }
        type="submit"
      >
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
  const [editAutomatic, setEditAutomatic] = useState(false);
  const [deletePlan, setDeletePlan] = useState<DeletePlan | null>(null);
  const [filters, setFilters] = useState({
    dateFrom: shiftNow.shiftDate,
    dateTo: shiftNow.shiftDate,
    pump: "",
    shiftType: "",
    category: "",
    clientId: "",
    containerStatus: "",
    includeDeleted: false
  });
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const createGapState = useGapPreview(form, setForm);
  const editGapState = useGapPreview(editForm, setEditForm, editId);

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
    if (filters.containerStatus) query.set("containerStatus", filters.containerStatus);
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
      try {
        await loadEvents();
      } catch (historyError) {
        setError(
          historyError instanceof Error
            ? `Lançamento salvo, mas o histórico não pôde ser atualizado: ${historyError.message}`
            : "Lançamento salvo, mas o histórico não pôde ser atualizado."
        );
      }
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
      containerStatus: item.containerStatus || (item.category === "PRODUTIVO" ? "FULL" : null),
      containerReason: item.containerReason || "",
      startsNewContainerCycle: Boolean(item.startsNewContainerCycle),
      blendConfirmed: Boolean(item.blendConfirmed),
      expectedContainerStateVersion: item.containerStateVersion,
      notes: item.notes || "",
      revisionReason: "",
      gapPreview: null,
      gapJustifications: []
    });
    setEditAutomatic((item.origin || "MANUAL") === "AUTO_GAP");
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
      setEditAutomatic(false);
      await loadEvents();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao editar lançamento.");
    } finally {
      setLoading(false);
    }
  };

  const performDelete = async (plan: DeletePlan) => {
    setLoading(true);
    setError(null);
    try {
      await apiFetch(`/api/events/${plan.eventId}`, {
        method: "DELETE",
        body: JSON.stringify({
          reason: plan.reason,
          gapVersion: plan.preview.gapVersion,
          gapJustifications: plan.gapJustifications
        })
      });
      setDeletePlan(null);
      setMessage("Lançamento excluído e linha do tempo recalculada.");
      await loadEvents();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao excluir lançamento.");
    } finally {
      setLoading(false);
    }
  };

  const deleteEvent = async (item: EventApiItem) => {
    const reason = window.prompt("Informe o motivo da exclusão:");

    if (!reason) {
      return;
    }

    try {
      const preview = await apiFetch<GapPreview>("/api/events/gap-preview", {
        method: "POST",
        body: JSON.stringify({
          pump: item.pump,
          shiftDate: item.shiftDate,
          shiftType: item.shiftType,
          startTime: item.startTime,
          endTime: item.endTime,
          eventId: item.id,
          operation: "DELETE"
        })
      });
      const plan: DeletePlan = {
        eventId: item.id,
        reason,
        preview,
        gapJustifications: preview.requiresJustification
          ? preview.uncoveredSegments.map((segment) => ({
              ...segment,
              category: "OUTROS",
              clientId: null,
              plate: null,
              notes: null
            }))
          : []
      };
      if (preview.requiresJustification) {
        setDeletePlan(plan);
      } else {
        await performDelete(plan);
      }
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
          setForm={setForm}
          submitLabel="Salvar lançamento"
          gapState={createGapState}
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
                setEditAutomatic(false);
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
            isEditing
            isAutomatic={editAutomatic}
            loading={loading}
            onSubmit={handleEdit}
            setForm={setEditForm as Dispatch<SetStateAction<EventFormState>>}
            submitLabel="Salvar edição"
            gapState={editGapState}
          />
        </div>
      ) : null}

      {deletePlan ? (
        <DeleteReconciliationPanel
          clients={clients}
          loading={loading}
          onCancel={() => setDeletePlan(null)}
          onChange={setDeletePlan}
          onConfirm={() => performDelete(deletePlan)}
          plan={deletePlan}
        />
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
              {reportCategoryOptions.map((cat) => (
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
          <label className="field-label">
            Estado do container
            <select
              className="select-ui"
              onChange={(e) => setFilters({ ...filters, containerStatus: e.target.value })}
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
                    {(item.origin || "MANUAL") === "AUTO_GAP" ? (
                      <span className="ml-2 inline-flex rounded-full border border-teal-300 bg-teal-50 px-2 py-0.5 text-[0.68rem] font-extrabold uppercase tracking-wide text-teal-800">
                        Automático
                      </span>
                    ) : null}
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
                  {item.deleted && canRestore && (item.origin || "MANUAL") !== "AUTO_GAP" ? (
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
              {item.containerStatus ? (
                <div className="container-history-summary">
                  <span className={`container-status-badge status-${item.containerStatus.toLowerCase()}`}>
                    {containerStatusLabelMap[item.containerStatus]}
                  </span>
                  {item.containerReason ? <span>Motivo: {item.containerReason}</span> : null}
                </div>
              ) : null}
              <p className="history-meta">
                <strong>Placa:</strong> {item.plate || "-"} • <strong>Container:</strong>{" "}
                {item.container || "-"}
              </p>
              <p className="history-meta">Criado por: {item.createdByEmail}</p>
              {item.previousContainerPassages?.length ? (
                <details className="container-history-details">
                  <summary>
                    Ver passagens anteriores ({item.previousContainerPassages.length})
                  </summary>
                  <ol className="container-cycle-passages">
                    {item.previousContainerPassages.map((passage, index) => (
                      <li key={passage.id}>
                        <span className="container-passage-index">
                          {index + 1}ª passagem
                        </span>
                        <span>
                          {toClockLabel(passage.startTime)}–{toClockLabel(passage.endTime)}
                        </span>
                        <span>{pumpShortLabel(passage.pump)}</span>
                        <span>{passage.plate || "Sem placa"}</span>
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
                  Editado em: {toViewDate(item.updatedAt)} ({item.updatedByEmail})
                </p>
              ) : null}
              {item.deleted ? (
                <p className="notice error mt-2">
                  Excluído: {item.deletedReason || "-"} ({item.deletedByEmail || "-"})
                </p>
              ) : null}

              {isManager && !item.deleted && (item.origin || "MANUAL") !== "AUTO_GAP" ? (
                <div className="history-actions">
                  <button className="btn-danger" onClick={() => deleteEvent(item)} type="button">
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
