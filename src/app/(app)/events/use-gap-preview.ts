"use client";

import {
  Dispatch,
  SetStateAction,
  useEffect,
  useState
} from "react";
import { apiFetch } from "@/lib/auth/api-fetch";
import { buildGapJustificationsByEvent } from "@/lib/ui/event-reconciliation";
import { GapPreview } from "@/types/domain";
import { EventFormState } from "./event-model";

type GapPreviewStatus = {
  requestKey: string | null;
  loading: boolean;
  error: string | null;
};

export function useGapPreview<T extends EventFormState | null>(
  form: T,
  setForm: Dispatch<SetStateAction<T>>,
  eventId?: string | null
) {
  const [status, setStatus] = useState<GapPreviewStatus>({
    requestKey: null,
    loading: false,
    error: null
  });
  const pump = form?.pump;
  const shiftDate = form?.shiftDate;
  const shiftType = form?.shiftType;
  const startTime = form?.startTime;
  const endTime = form?.endTime;
  const category = form?.category;
  const requestEnabled = Boolean(
    category === "PRODUTIVO" &&
      startTime &&
      shiftDate &&
      pump &&
      shiftType
  );
  const requestKey = requestEnabled
    ? JSON.stringify([
        pump,
        shiftDate,
        shiftType,
        startTime,
        endTime || "",
        eventId || ""
      ])
    : null;

  useEffect(() => {
    if (!requestKey || !startTime || !shiftDate || !pump || !shiftType) {
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setStatus({
        requestKey,
        loading: true,
        error: null
      });

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
          if (!current) {
            return current;
          }

          const previous = new Map(
            current.gapJustifications.map((item) => [item.id, item])
          );
          const gapJustifications = preview.requiresJustification
            ? preview.uncoveredSegments.map(
                (segment) =>
                  previous.get(segment.id) || {
                    ...segment,
                    category: "OUTROS",
                    clientId: null,
                    plate: null,
                    notes: null
                  }
              )
            : [];
          const gapJustificationsByEvent = buildGapJustificationsByEvent(
            preview.reconciliations || [],
            current.gapJustificationsByEvent
          );

          return {
            ...current,
            gapPreview: preview,
            gapJustifications,
            gapJustificationsByEvent
          } as T;
        });
      } catch (reason) {
        if (!controller.signal.aborted) {
          setStatus({
            requestKey,
            loading: false,
            error:
              reason instanceof Error
                ? reason.message
                : "Falha ao calcular o intervalo."
          });
          setForm((current) =>
            current
              ? ({
                  ...current,
                  gapPreview: null,
                  gapJustificationsByEvent: {}
                } as T)
              : current
          );
        }
      } finally {
        if (!controller.signal.aborted) {
          setStatus((current) =>
            current.requestKey === requestKey
              ? { ...current, loading: false }
              : current
          );
        }
      }
    }, 350);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    category,
    endTime,
    eventId,
    pump,
    requestKey,
    setForm,
    shiftDate,
    shiftType,
    startTime
  ]);

  return {
    loading: status.requestKey === requestKey && status.loading,
    error: status.requestKey === requestKey ? status.error : null
  };
}
