"use client";

import { categoryRules } from "@/lib/domain/constants";
import { formatPlateForInput } from "@/lib/domain/identifiers";
import { idleCategoryOptions } from "@/lib/domain/options";
import { ClientApiItem } from "@/types/api";
import { GapJustification, GapPreview } from "@/types/domain";
import {
  DeletePlan,
  formatDuration,
  RestorePlan
} from "./event-model";

type ReconciliationPreviewListProps = {
  reconciliations: NonNullable<GapPreview["reconciliations"]>;
  gapJustificationsByEvent: Record<string, GapJustification[]>;
  clients: ClientApiItem[];
  restoredEventId?: string;
  onPatch: (
    eventId: string,
    justificationId: string,
    patch: Partial<GapJustification>
  ) => void;
};

export function ReconciliationPreviewList({
  reconciliations,
  gapJustificationsByEvent,
  clients,
  restoredEventId,
  onPatch
}: ReconciliationPreviewListProps) {
  if (!reconciliations.length) {
    return (
      <div className="notice success">
        A operação não exige recalcular outros lançamentos.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {reconciliations.map(({ eventId, preview }, reconciliationIndex) => (
        <section
          className="space-y-2 rounded-xl border border-amber-200 bg-white p-3"
          key={eventId}
        >
          <div>
            <h3 className="text-sm font-extrabold text-slate-800">
              {eventId === restoredEventId
                ? "Lançamento restaurado"
                : `Lançamento afetado ${reconciliationIndex + 1}`}
            </h3>
            <p className="text-xs text-slate-500">
              {preview.uncoveredSegments.length
                ? `${formatDuration(
                    preview.uncoveredMinutes
                  )} serão recalculados.`
                : "A linha do tempo permanecerá contínua."}
            </p>
          </div>

          {!preview.requiresJustification &&
          preview.uncoveredSegments.length ? (
            <div className="notice success">
              O intervalo será registrado automaticamente como Intervalo
              operacional.
            </div>
          ) : null}

          {(gapJustificationsByEvent[eventId] || []).map((item, index) => {
            const rules = categoryRules[item.category];

            return (
              <fieldset
                className="grid grid-cols-2 gap-3 rounded-xl border border-amber-200 bg-amber-50/50 p-3"
                key={item.id}
              >
                <legend className="px-2 text-sm font-extrabold">
                  Trecho {index + 1}: {item.startTime}–{item.endTime} (
                  {item.durationMinutes} min)
                </legend>
                <label className="field-label col-span-2">
                  Causa
                  <select
                    className="select-ui"
                    onChange={(event) =>
                      onPatch(eventId, item.id, {
                        category: event.target
                          .value as GapJustification["category"],
                        clientId: null,
                        plate: null,
                        notes: null
                      })
                    }
                    value={item.category}
                  >
                    {idleCategoryOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                {rules.requiresClient ? (
                  <label className="field-label col-span-2">
                    Cliente *
                    <select
                      className="select-ui"
                      onChange={(event) =>
                        onPatch(eventId, item.id, {
                          clientId: event.target.value || null
                        })
                      }
                      required
                      value={item.clientId || ""}
                    >
                      <option value="">Selecione</option>
                      {clients.map((client) => (
                        <option key={client.id} value={client.id}>
                          {client.name}
                        </option>
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
                        onPatch(eventId, item.id, {
                          plate:
                            formatPlateForInput(event.target.value) || null
                        })
                      }
                      required
                      value={item.plate || ""}
                    />
                  </label>
                ) : null}
                {rules.requiresNotes ? (
                  <label
                    className={`field-label ${
                      rules.requiresPlate ? "" : "col-span-2"
                    }`}
                  >
                    Observação *
                    <textarea
                      className="textarea-ui"
                      onChange={(event) =>
                        onPatch(eventId, item.id, {
                          notes: event.target.value || null
                        })
                      }
                      required
                      value={item.notes || ""}
                    />
                  </label>
                ) : null}
              </fieldset>
            );
          })}
        </section>
      ))}
    </div>
  );
}

type RestoreReconciliationPanelProps = {
  plan: RestorePlan;
  clients: ClientApiItem[];
  loading: boolean;
  onChange: (next: RestorePlan) => void;
  onCancel: () => void;
  onConfirm: () => void;
};

export function RestoreReconciliationPanel({
  plan,
  clients,
  loading,
  onChange,
  onCancel,
  onConfirm
}: RestoreReconciliationPanelProps) {
  const patch = (
    eventId: string,
    justificationId: string,
    change: Partial<GapJustification>
  ) => {
    onChange({
      ...plan,
      gapJustificationsByEvent: {
        ...plan.gapJustificationsByEvent,
        [eventId]: (
          plan.gapJustificationsByEvent[eventId] || []
        ).map((item) =>
          item.id === justificationId ? { ...item, ...change } : item
        )
      }
    });
  };

  return (
    <form
      className="panel space-y-3 border-amber-300 bg-amber-50"
      onSubmit={(event) => {
        event.preventDefault();
        onConfirm();
      }}
    >
      <div>
        <p className="text-xs font-extrabold uppercase tracking-[0.16em] text-amber-800">
          Prévia de restauração
        </p>
        <h2 className="panel-title mt-1">
          Confirme a reconciliação da linha do tempo
        </h2>
        <p className="mt-1 text-sm text-amber-950">
          {plan.preview.changedSinceDeletion
            ? "A linha do tempo mudou desde a exclusão. Revise todos os impactos antes de restaurar."
            : "Revise os intervalos que serão recriados antes de restaurar."}
        </p>
      </div>

      <ReconciliationPreviewList
        clients={clients}
        gapJustificationsByEvent={plan.gapJustificationsByEvent}
        onPatch={patch}
        reconciliations={plan.preview.reconciliations}
        restoredEventId={plan.eventId}
      />

      <div className="flex justify-end gap-2">
        <button
          className="btn-soft"
          disabled={loading}
          onClick={onCancel}
          type="button"
        >
          Cancelar
        </button>
        <button className="btn-primary" disabled={loading} type="submit">
          {loading ? "Restaurando…" : "Confirmar restauração"}
        </button>
      </div>
    </form>
  );
}

type DeleteReconciliationPanelProps = {
  plan: DeletePlan;
  clients: ClientApiItem[];
  loading: boolean;
  onChange: (next: DeletePlan) => void;
  onCancel: () => void;
  onConfirm: () => void;
};

export function DeleteReconciliationPanel({
  plan,
  clients,
  loading,
  onChange,
  onCancel,
  onConfirm
}: DeleteReconciliationPanelProps) {
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
          Excluir este produtivo abrirá{" "}
          {formatDuration(plan.preview.uncoveredMinutes)} antes do próximo
          lançamento. Informe uma causa para cada trecho.
        </p>
      </div>
      {plan.gapJustifications.map((item, index) => {
        const rules = categoryRules[item.category];

        return (
          <fieldset
            className="grid grid-cols-2 gap-3 rounded-xl border border-amber-200 bg-white p-3"
            key={item.id}
          >
            <legend className="px-2 text-sm font-extrabold">
              Trecho {index + 1}: {item.startTime}–{item.endTime} (
              {item.durationMinutes} min)
            </legend>
            <label className="field-label col-span-2">
              Causa
              <select
                className="select-ui"
                onChange={(event) =>
                  patch(item.id, {
                    category: event.target
                      .value as GapJustification["category"],
                    clientId: null,
                    plate: null,
                    notes: null
                  })
                }
                value={item.category}
              >
                {idleCategoryOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            {rules.requiresClient ? (
              <label className="field-label col-span-2">
                Cliente *
                <select
                  className="select-ui"
                  onChange={(event) =>
                    patch(item.id, {
                      clientId: event.target.value || null
                    })
                  }
                  required
                  value={item.clientId || ""}
                >
                  <option value="">Selecione</option>
                  {clients.map((client) => (
                    <option key={client.id} value={client.id}>
                      {client.name}
                    </option>
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
                    patch(item.id, {
                      plate:
                        formatPlateForInput(event.target.value) || null
                    })
                  }
                  required
                  value={item.plate || ""}
                />
              </label>
            ) : null}
            {rules.requiresNotes ? (
              <label
                className={`field-label ${
                  rules.requiresPlate ? "" : "col-span-2"
                }`}
              >
                Observação *
                <textarea
                  className="textarea-ui"
                  onChange={(event) =>
                    patch(item.id, {
                      notes: event.target.value || null
                    })
                  }
                  required
                  value={item.notes || ""}
                />
              </label>
            ) : null}
          </fieldset>
        );
      })}
      <div className="flex justify-end gap-2">
        <button
          className="btn-soft"
          disabled={loading}
          onClick={onCancel}
          type="button"
        >
          Cancelar
        </button>
        <button
          className="btn-danger"
          disabled={loading}
          onClick={onConfirm}
          type="button"
        >
          {loading ? "Excluindo…" : "Confirmar exclusão e recalcular"}
        </button>
      </div>
    </section>
  );
}
