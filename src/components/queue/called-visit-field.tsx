"use client";
import { useEffect, useState } from "react";
import { useAuthSession } from "@/lib/auth/use-auth-session";
import { apiFetch } from "@/lib/auth/api-fetch";
import type { EventFormState } from "@/app/(app)/events/event-model";
import { formatPlateForInput } from "@/lib/domain/identifiers";
type Visit = {
  id: string;
  plate: string;
  clientId: string;
  clientName: string;
  version: number;
};
export function CalledVisitField({
  form,
  onChange,
}: {
  form: EventFormState;
  onChange: (patch: Partial<EventFormState>) => void;
}) {
  const { checkinsEnabled } = useAuthSession();
  const [visits, setVisits] = useState<Visit[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState("");
  async function load(signal?: AbortSignal) {
    const result = await apiFetch<{ enabled: boolean; items: Visit[] }>(
      "/api/checkins/called",
      { signal },
    );
    setVisits(result.items);
    setEnabled(result.enabled);
    setError("");
  }
  useEffect(() => {
    if (!checkinsEnabled) return;
    const controller = new AbortController();
    void apiFetch<{ enabled: boolean; items: Visit[] }>(
      "/api/checkins/called",
      { signal: controller.signal },
    )
      .then((result) => {
        if (!controller.signal.aborted) {
          setVisits(result.items);
          setEnabled(result.enabled);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [checkinsEnabled]);
  if (!checkinsEnabled || (!enabled && !error)) return null;
  return (
    <section className="col-span-2 panel">
      <label className="field-label">
        Visita chamada
        <select
          aria-label="Visita chamada"
          value={form.checkInId ?? ""}
          onChange={(e) => {
            const visit = visits.find((v) => v.id === e.target.value);
            onChange(
              visit
                ? {
                    checkInId: visit.id,
                    expectedCheckinVersion: visit.version,
                    plate: formatPlateForInput(visit.plate),
                    originInput: formatPlateForInput(visit.plate),
                    clientId: visit.clientId,
                    loadSourceType: "TRUCK",
                    sourceContainer: "",
                    sourceContainerEmptied: null,
                    expectedSourceContainerStateVersion: null,
                    expectedSourceContainerCycleId: null,
                  }
                : { checkInId: undefined, expectedCheckinVersion: undefined },
            );
          }}
        >
          <option value="">Selecione uma visita</option>
          {visits.map((v) => (
            <option key={v.id} value={v.id}>
              {v.plate} · {v.clientName}
            </option>
          ))}
        </select>
      </label>
      <p className="text-xs muted mt-2">
        A visita entra em descarga somente quando este lançamento for salvo.
      </p>
      <button
        type="button"
        className="btn-soft mt-2"
        onClick={() => void load().catch((e) => setError(e.message))}
      >
        Atualizar visitas
      </button>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
    </section>
  );
}
