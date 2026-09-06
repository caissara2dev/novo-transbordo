"use client";

import { originCode } from "@/lib/domain/container-transfer";

import { Dispatch, SetStateAction } from "react";
import { categoryRules } from "@/lib/domain/constants";
import { formatPlateForInput } from "@/lib/domain/identifiers";
import { idleCategoryOptions } from "@/lib/domain/options";
import { ClientApiItem } from "@/types/api";
import { GapJustification } from "@/types/domain";
import {
  categoryNotesPlaceholders,
  EventFormState,
  formatDuration
} from "./event-model";

type GapPanelProps = {
  form: EventFormState;
  setForm: Dispatch<SetStateAction<EventFormState>>;
  clients: ClientApiItem[];
  gapState: { loading: boolean; error: string | null };
};

export function GapPanel({ form, setForm, clients, gapState }: GapPanelProps) {
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

  if (!form.startTime || !preview) {
    return null;
  }

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
        <strong>{formatDuration(preview.uncoveredMinutes)}</strong> de intervalo
        serão registrados automaticamente como{" "}
        <strong>Intervalo operacional</strong>. O limite sem justificativa é de{" "}
        {preview.toleranceMinutes} min.
      </div>
    );
  }

  return (
    <section className="col-span-2 space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-3">
      <div>
        <h3 className="text-base font-extrabold text-amber-950">
          Justificativa obrigatória
        </h3>
        <p className="text-sm text-amber-900">
          Há {formatDuration(preview.uncoveredMinutes)} sem cobertura. Informe
          uma causa para cada trecho antes de salvar.
        </p>
      </div>
      {form.gapJustifications.map((item, index) => {
        const rules = categoryRules[item.category];

        return (
          <fieldset
            className="grid grid-cols-2 gap-3 rounded-xl border border-amber-200 bg-white p-3"
            key={item.id}
          >
            <legend className="px-2 text-sm font-extrabold text-slate-700">
              Trecho {index + 1}: {item.startTime}–{item.endTime} (
              {item.durationMinutes} min)
            </legend>
            <label className="field-label col-span-2">
              Causa
              <select
                className="select-ui"
                onChange={(event) => {
                  const category = event.target
                    .value as GapJustification["category"];

                  setForm((current) => {
                    const currentJustification = current.gapJustifications.find(
                      (justification) => justification.id === item.id
                    );
                    const copiedPlate = currentJustification?.plate || "";
                    const shouldClearProductivePlate =
                      currentJustification?.category === "EM_TRANSITO" &&
                      category !== "EM_TRANSITO" &&
                      current.loadSourceType === "TRUCK" &&
                      originCode(current.originInput) ===
                        originCode(copiedPlate);

                    return {
                      ...current,
                      plate: shouldClearProductivePlate ? "" : current.plate,
                      originInput: shouldClearProductivePlate
                        ? ""
                        : current.originInput,
                      gapJustifications: current.gapJustifications.map(
                        (justification) =>
                          justification.id === item.id
                            ? {
                                ...justification,
                                category,
                                clientId: null,
                                plate: null,
                                notes: null
                              }
                            : justification
                      )
                    };
                  });
                }}
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
                    patchJustification(item.id, {
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
              <label className="field-label col-span-2 md:col-span-1">
                Placa *
                <input
                  className="input-ui"
                  onChange={(event) => {
                    const plate = formatPlateForInput(event.target.value);

                    setForm((current) => {
                      const currentJustification =
                        current.gapJustifications.find(
                          (justification) => justification.id === item.id
                        );
                      const previousGapPlate =
                        currentJustification?.plate || "";
                      const shouldFillProductivePlate =
                        currentJustification?.category === "EM_TRANSITO" &&
                        current.loadSourceType === "TRUCK" &&
                        (!current.originInput ||
                          originCode(current.originInput) ===
                            originCode(previousGapPlate));

                      return {
                        ...current,
                        originInput: shouldFillProductivePlate
                          ? plate
                          : current.originInput,
                        plate: shouldFillProductivePlate
                          ? plate
                          : current.plate,
                        gapJustifications: current.gapJustifications.map(
                          (justification) =>
                            justification.id === item.id
                              ? { ...justification, plate: plate || null }
                              : justification
                        )
                      };
                    });
                  }}
                  required
                  value={item.plate || ""}
                />
              </label>
            ) : null}
            {rules.requiresNotes ? (
              <label
                className={`field-label ${
                  rules.requiresPlate ? "md:col-span-1" : "col-span-2"
                }`}
              >
                Observação *
                <textarea
                  className="textarea-ui"
                  onChange={(event) =>
                    patchJustification(item.id, {
                      notes: event.target.value || null
                    })
                  }
                  placeholder={categoryNotesPlaceholders[item.category]}
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
