"use client";

import {
  Dispatch,
  FormEvent,
  SetStateAction
} from "react";
import { ContainerStatusFields } from "@/components/container-status-fields";
import { ContainerTransferFields } from "@/components/container-transfer-fields";
import { categoryRules } from "@/lib/domain/constants";
import {
  formatContainerForInput,
  formatPlateForInput
} from "@/lib/domain/identifiers";
import {
  idleCategoryOptions,
  pumpOptions,
  shiftOptions
} from "@/lib/domain/options";
import { computeWindowCheck } from "@/lib/domain/time";
import { ClientApiItem } from "@/types/api";
import { ShiftType } from "@/types/domain";
import {
  categoryDescriptions,
  categoryNotesPlaceholders,
  EventFormState
} from "./event-model";
import { GapPanel } from "./gap-panel";
import { ReconciliationPreviewList } from "./reconciliation-panels";

type EventFormFieldsProps = {
  form: EventFormState;
  setForm: Dispatch<SetStateAction<EventFormState>>;
  clients: ClientApiItem[];
  submitLabel: string;
  onSubmit: (event: FormEvent) => Promise<void>;
  loading: boolean;
  isEditing?: boolean;
  isAutomatic?: boolean;
  gapState: { loading: boolean; error: string | null };
};

export function EventFormFields({
  form,
  setForm,
  clients,
  submitLabel,
  onSubmit,
  loading,
  isEditing = false,
  isAutomatic = false,
  gapState
}: EventFormFieldsProps) {
  const rules = categoryRules[form.category];
  const warningStart = form.startTime
    ? !computeWindowCheck(form.shiftType, form.startTime)
    : false;
  const warningEnd = form.endTime
    ? !computeWindowCheck(form.shiftType, form.endTime)
    : false;

  return (
    <form className="grid grid-cols-2 gap-3" onSubmit={onSubmit}>
      <div className="field-label col-span-2">
        Bomba
        <div className="choice-grid">
          {pumpOptions.map((pump) => (
            <button
              className={`choice-card ${
                form.pump === pump.value ? "active" : ""
              }`}
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
          onChange={(event) =>
            setForm({ ...form, shiftDate: event.target.value })
          }
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
          onChange={(event) =>
            setForm({
              ...form,
              shiftType: event.target.value as ShiftType
            })
          }
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
          onChange={(event) =>
            setForm({ ...form, startTime: event.target.value })
          }
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
          onChange={(event) =>
            setForm({ ...form, endTime: event.target.value })
          }
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
            {form.category === "PRODUTIVO"
              ? "Lançamento produtivo"
              : "Ociosidade manual"}
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
                category:
                  form.category === "PRODUTIVO" ? "OUTROS" : "PRODUTIVO",
                containerStatus:
                  form.category === "PRODUTIVO"
                    ? null
                    : form.containerStatus || "FULL",
                loadSourceType: "TRUCK",
                sourceContainer: "",
                sourceContainerEmptied: null,
                expectedSourceContainerStateVersion: null,
                gapPreview: null,
                gapJustifications: [],
                gapJustificationsByEvent: {}
              })
            }
            type="button"
          >
            {form.category === "PRODUTIVO"
              ? "Registrar ociosidade"
              : "Voltar ao produtivo"}
          </button>
        ) : (
          <span className="pill">Horários derivados</span>
        )}
      </div>

      {form.category !== "PRODUTIVO" ? (
        <div className="field-label col-span-2">
          Causa da ociosidade
          <div className="choice-grid category-grid">
            {idleCategoryOptions.map((category) => (
              <button
                className={`choice-card ${
                  form.category === category.value ? "active" : ""
                }`}
                key={category.value}
                onClick={() =>
                  setForm({
                    ...form,
                    category: category.value,
                    containerStatus: null,
                    containerReason: "",
                    startsNewContainerCycle: false,
                    blendConfirmed: false,
                    expectedContainerStateVersion: null,
                    loadSourceType: "TRUCK",
                    sourceContainer: "",
                    sourceContainerEmptied: null,
                    expectedSourceContainerStateVersion: null
                  })
                }
                type="button"
              >
                {category.label}
                <span className="choice-card-detail">
                  {categoryDescriptions[category.value]}
                </span>
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

      {form.category === "PRODUTIVO" &&
      form.gapPreview?.reconciliations?.length ? (
        <section className="col-span-2 space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-3">
          <div>
            <h3 className="text-base font-extrabold text-amber-950">
              Outros lançamentos serão reconciliados
            </h3>
            <p className="text-sm text-amber-900">
              A edição altera intervalos de lançamentos posteriores. Revise
              cada trecho.
            </p>
          </div>
          <ReconciliationPreviewList
            clients={clients}
            gapJustificationsByEvent={form.gapJustificationsByEvent}
            onPatch={(eventId, justificationId, patch) =>
              setForm((current) => ({
                ...current,
                gapJustificationsByEvent: {
                  ...current.gapJustificationsByEvent,
                  [eventId]: (
                    current.gapJustificationsByEvent[eventId] || []
                  ).map((item) =>
                    item.id === justificationId
                      ? { ...item, ...patch }
                      : item
                  )
                }
              }))
            }
            reconciliations={form.gapPreview.reconciliations}
          />
        </section>
      ) : null}

      {form.category === "PRODUTIVO" ? (
        <ContainerTransferFields
          fields={form}
          onChange={(patch) => setForm({ ...form, ...patch })}
        />
      ) : null}

      <label className="field-label col-span-2">
        Cliente {rules.requiresClient ? "*" : ""}
        <select
          className="select-ui"
          onChange={(event) =>
            setForm({ ...form, clientId: event.target.value })
          }
          required={rules.requiresClient}
          disabled={
            form.category === "PRODUTIVO" &&
            form.loadSourceType === "BUFFER_CONTAINER"
          }
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

      {form.category !== "PRODUTIVO" || form.loadSourceType === "TRUCK" ? (
        <label className="field-label">
          Placa {rules.requiresPlate ? "*" : ""}
          <input
            className="input-ui"
            onChange={(event) =>
              setForm({
                ...form,
                plate: formatPlateForInput(event.target.value)
              })
            }
            placeholder="AAA1234 ou AAA1A23"
            required={rules.requiresPlate}
            type="text"
            value={form.plate}
          />
        </label>
      ) : null}

      <label
        className={`field-label ${
          form.category === "PRODUTIVO" &&
          form.loadSourceType === "BUFFER_CONTAINER"
            ? "col-span-2"
            : ""
        }`}
      >
        Container {rules.requiresContainer ? "*" : ""}
        <input
          className="input-ui"
          onChange={(event) =>
            setForm({
              ...form,
              container: formatContainerForInput(event.target.value),
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
          onChange={(event) =>
            setForm({ ...form, notes: event.target.value })
          }
          placeholder={categoryNotesPlaceholders[form.category]}
          required={rules.requiresNotes}
          value={form.notes}
        />
      </label>

      <button
        className="btn-primary col-span-2 w-full"
        disabled={
          loading ||
          gapState.loading ||
          (form.category === "PRODUTIVO" &&
            form.loadSourceType === "BUFFER_CONTAINER" &&
            (form.sourceContainerEmptied === null ||
              !form.sourceContainer ||
              formatContainerForInput(form.sourceContainer) ===
                formatContainerForInput(form.container))) ||
          Boolean(
            form.category === "PRODUTIVO" &&
              form.startTime &&
              !form.gapPreview
          )
        }
        type="submit"
      >
        {loading ? "Salvando..." : submitLabel}
      </button>
    </form>
  );
}
