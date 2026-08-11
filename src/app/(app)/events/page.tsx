"use client";

import {
  Dispatch,
  FormEvent,
  SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  ApiRequestError,
  apiFetch,
  authenticatedFetch,
  readApiResponse
} from "@/lib/auth/api-fetch";
import { useAuthSession } from "@/lib/auth/use-auth-session";
import {
  buildGapJustificationsByEvent,
  buildRestoreRequestPayload,
  isRestorePreviewConflict
} from "@/lib/ui/event-reconciliation";
import {
  EventListFilters,
  filtersAreEqual
} from "@/lib/ui/filters";
import { revealEditHeading } from "@/lib/ui/edit-panel-focus";
import {
  createLatestRequestCoordinator,
  isAbortError
} from "@/lib/ui/latest-request";
import {
  ClientApiItem,
  EventApiItem,
  PaginatedResponse,
  RestoreEventPreviewResponse
} from "@/types/api";
import { GapJustification, GapPreview } from "@/types/domain";
import { EventFormFields } from "./event-form-fields";
import {
  DeletePlan,
  EventFormState,
  makeInitialEventFilters,
  makeInitialForm,
  mergeEventPageItems,
  RestorePlan,
  toEventPageQuery,
  toPayload
} from "./event-model";
import { EventsHistory } from "./events-history";
import {
  DeleteReconciliationPanel,
  RestoreReconciliationPanel
} from "./reconciliation-panels";
import { useGapPreview } from "./use-gap-preview";

class RestoreResponseError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function submitEventRestore(plan: RestorePlan): Promise<void> {
  const response = await authenticatedFetch(
    `/api/events/${plan.eventId}/restore`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(
        buildRestoreRequestPayload(
          plan.preview,
          plan.gapJustificationsByEvent
        )
      )
    }
  );

  try {
    await readApiResponse(response);
  } catch (error) {
    if (error instanceof ApiRequestError) {
      throw new RestoreResponseError(error.status, error.message);
    }
    throw error;
  }
}

export default function EventsPage() {
  const { profile } = useAuthSession();
  const initialFilters = useMemo(() => makeInitialEventFilters(), []);
  const [clients, setClients] = useState<ClientApiItem[]>([]);
  const [events, setEvents] = useState<EventApiItem[]>([]);
  const [form, setForm] = useState<EventFormState>(makeInitialForm);
  const [editForm, setEditForm] = useState<EventFormState | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editAutomatic, setEditAutomatic] = useState(false);
  const [editSelectionVersion, setEditSelectionVersion] = useState(0);
  const [deletePlan, setDeletePlan] = useState<DeletePlan | null>(null);
  const [restorePlan, setRestorePlan] = useState<RestorePlan | null>(null);
  const [draftFilters, setDraftFilters] = useState<EventListFilters>(() => ({
    ...initialFilters
  }));
  const [appliedFilters, setAppliedFilters] = useState<EventListFilters>(
    () => ({ ...initialFilters })
  );
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [incomplete, setIncomplete] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const appliedFiltersRef = useRef<EventListFilters>(initialFilters);
  const editHeadingRef = useRef<HTMLHeadingElement>(null);
  const clientRequests = useRef(createLatestRequestCoordinator());
  const eventRequests = useRef(createLatestRequestCoordinator());
  const createGapState = useGapPreview(form, setForm);
  const editGapState = useGapPreview(editForm, setEditForm, editId);

  useEffect(() => {
    if (!editId || editSelectionVersion === 0) {
      return;
    }

    revealEditHeading(editHeadingRef.current);
  }, [editId, editSelectionVersion]);

  const isManager = useMemo(
    () =>
      profile?.role === "SUPERVISOR" || profile?.role === "ADMIN",
    [profile?.role]
  );
  const canRestore = profile?.role === "ADMIN";

  const loadClients = useCallback(async () => {
    const request = clientRequests.current.begin();

    try {
      const data = await apiFetch<{ items: ClientApiItem[] }>(
        "/api/clients",
        { signal: request.signal }
      );

      if (!request.isCurrent()) {
        return;
      }

      setClients(data.items || []);
    } catch (reason) {
      if (!request.isCurrent() || isAbortError(reason)) {
        return;
      }

      throw reason;
    }
  }, []);

  const loadEvents = useCallback(
    async (
      filters: EventListFilters,
      cursor?: string | null
    ) => {
      const request = eventRequests.current.begin();
      const appending = Boolean(cursor);

      if (appending) {
        setLoadingMore(true);
      } else {
        setLoadingMore(false);
        setNextCursor(null);
        setIncomplete(false);
      }

      try {
        const data = await apiFetch<PaginatedResponse<EventApiItem>>(
          `/api/events?${toEventPageQuery(filters, cursor)}`,
          { signal: request.signal }
        );

        if (!request.isCurrent()) {
          return;
        }

        setEvents((current) =>
          appending
            ? mergeEventPageItems(current, data.items || [])
            : data.items || []
        );
        setNextCursor(data.nextCursor);
        setIncomplete(data.incomplete);
      } catch (reason) {
        if (!request.isCurrent() || isAbortError(reason)) {
          return;
        }

        throw reason;
      } finally {
        if (request.isCurrent()) {
          setLoadingMore(false);
        }
      }
    },
    []
  );

  useEffect(() => {
    const requests = clientRequests.current;

    if (!profile?.approved) {
      requests.cancel();
      return;
    }

    void loadClients().catch((reason) =>
      setError(
        reason instanceof Error
          ? reason.message
          : "Erro ao carregar clientes."
      )
    );

    return () => {
      requests.cancel();
    };
  }, [profile?.approved, loadClients]);

  useEffect(() => {
    const requests = eventRequests.current;
    appliedFiltersRef.current = appliedFilters;

    if (!profile?.approved) {
      requests.cancel();
      return;
    }

    const timer = window.setTimeout(() => {
      void loadEvents(appliedFilters).catch((reason) =>
        setError(
          reason instanceof Error
            ? reason.message
            : "Erro ao carregar lançamentos."
        )
      );
    }, 0);

    return () => {
      window.clearTimeout(timer);
      requests.cancel();
    };
  }, [profile?.approved, appliedFilters, loadEvents]);

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);

    try {
      const response = await apiFetch<{ item: EventApiItem }>(
        "/api/events",
        {
          method: "POST",
          body: JSON.stringify(toPayload(form))
        }
      );

      setMessage(
        response.item.warnings?.length
          ? `Lançamento salvo com avisos: ${response.item.warnings.join(
              " | "
            )}`
          : "Lançamento salvo com sucesso."
      );
      setForm(makeInitialForm());

      try {
        await loadEvents(appliedFiltersRef.current);
      } catch {
        setError(
          "O histórico está temporariamente indisponível. O lançamento foi salvo e não precisa ser enviado novamente. Atualize a página em alguns minutos."
        );
      }
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Erro ao salvar lançamento."
      );
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
      containerStatus:
        item.containerStatus ||
        (item.category === "PRODUTIVO" ? "FULL" : null),
      containerReason: item.containerReason || "",
      startsNewContainerCycle: Boolean(item.startsNewContainerCycle),
      blendConfirmed: Boolean(item.blendConfirmed),
      expectedContainerStateVersion: item.containerStateVersion,
      notes: item.notes || "",
      revisionReason: "",
      gapPreview: null,
      gapJustifications: [],
      gapJustificationsByEvent: {}
    });
    setEditAutomatic((item.origin || "MANUAL") === "AUTO_GAP");
    setEditSelectionVersion((current) => current + 1);
  };

  const handleEdit = async (event: FormEvent) => {
    event.preventDefault();
    if (!editId || !editForm) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await apiFetch<{ item: EventApiItem }>(
        `/api/events/${editId}`,
        {
          method: "PATCH",
          body: JSON.stringify(toPayload(editForm))
        }
      );

      setMessage(
        response.item.warnings?.length
          ? `Edição salva com avisos: ${response.item.warnings.join(
              " | "
            )}`
          : "Lançamento atualizado com sucesso."
      );
      setEditId(null);
      setEditForm(null);
      setEditAutomatic(false);
      await loadEvents(appliedFiltersRef.current);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Erro ao editar lançamento."
      );
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
      await loadEvents(appliedFiltersRef.current);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Erro ao excluir lançamento."
      );
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
      const preview = await apiFetch<GapPreview>(
        "/api/events/gap-preview",
        {
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
        }
      );
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
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "Erro ao excluir lançamento."
      );
    }
  };

  const fetchRestorePlan = async (
    eventId: string,
    previous: Record<string, GapJustification[]> = {}
  ): Promise<RestorePlan> => {
    const preview = await apiFetch<RestoreEventPreviewResponse>(
      `/api/events/${eventId}/restore`
    );

    return {
      eventId,
      preview,
      gapJustificationsByEvent: buildGapJustificationsByEvent(
        preview.reconciliations,
        previous
      )
    };
  };

  const previewRestore = async (eventId: string) => {
    setLoading(true);
    setError(null);
    setMessage(null);

    try {
      const plan = await fetchRestorePlan(eventId);
      setEditId(null);
      setEditForm(null);
      setEditAutomatic(false);
      setDeletePlan(null);
      setRestorePlan(plan);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Erro ao preparar a restauração do lançamento."
      );
    } finally {
      setLoading(false);
    }
  };

  const performRestore = async (plan: RestorePlan) => {
    setLoading(true);
    setError(null);

    try {
      await submitEventRestore(plan);
      setRestorePlan(null);
      setMessage("Lançamento restaurado.");
      await loadEvents(appliedFiltersRef.current);
    } catch (reason) {
      if (isRestorePreviewConflict(reason)) {
        try {
          const refreshed = await fetchRestorePlan(
            plan.eventId,
            plan.gapJustificationsByEvent
          );
          setRestorePlan(refreshed);
          setError(
            `${reason.message} A prévia foi atualizada; revise os impactos novamente.`
          );
        } catch (previewError) {
          setError(
            previewError instanceof Error
              ? previewError.message
              : "A linha do tempo mudou e não foi possível atualizar a prévia."
          );
        }
      } else {
        setError(
          reason instanceof Error
            ? reason.message
            : "Erro ao restaurar lançamento."
        );
      }
    } finally {
      setLoading(false);
    }
  };

  const applyFilters = (event: FormEvent) => {
    event.preventDefault();
    if (filtersAreEqual(draftFilters, appliedFiltersRef.current)) {
      return;
    }

    const nextFilters = { ...draftFilters };
    eventRequests.current.cancel();
    appliedFiltersRef.current = nextFilters;
    setLoadingMore(false);
    setNextCursor(null);
    setIncomplete(false);
    setAppliedFilters(nextFilters);
  };

  const loadMore = () => {
    if (!nextCursor || loadingMore) {
      return;
    }

    void loadEvents(appliedFiltersRef.current, nextCursor).catch(
      (reason) =>
        setError(
          reason instanceof Error
            ? reason.message
            : "Erro ao carregar mais lançamentos."
        )
    );
  };

  return (
    <section className="space-y-6">
      {error ? <div className="notice error">{error}</div> : null}
      {message ? (
        <div className="notice success">{message}</div>
      ) : null}

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
        <div
          aria-labelledby="edit-event-heading"
          className="panel border-amber-300 bg-amber-50/70"
          data-testid="event-edit-panel"
        >
          <div className="mb-2 flex items-center justify-between">
            <h2
              className="panel-title scroll-mt-16 text-2xl"
              id="edit-event-heading"
              ref={editHeadingRef}
              tabIndex={-1}
            >
              Editar lançamento
            </h2>
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
              onChange={(event) =>
                setEditForm({
                  ...editForm,
                  revisionReason: event.target.value
                })
              }
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
            setForm={
              setEditForm as Dispatch<
                SetStateAction<EventFormState>
              >
            }
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

      {restorePlan ? (
        <RestoreReconciliationPanel
          clients={clients}
          loading={loading}
          onCancel={() => setRestorePlan(null)}
          onChange={setRestorePlan}
          onConfirm={() => performRestore(restorePlan)}
          plan={restorePlan}
        />
      ) : null}

      <EventsHistory
        canRestore={canRestore}
        clients={clients}
        draftFilters={draftFilters}
        events={events}
        incomplete={incomplete}
        isManager={isManager}
        loading={loading}
        loadingMore={loadingMore}
        nextCursor={nextCursor}
        onApplyFilters={applyFilters}
        onDelete={deleteEvent}
        onEdit={startEdit}
        onLoadMore={loadMore}
        onRestore={previewRestore}
        setDraftFilters={setDraftFilters}
      />
    </section>
  );
}
