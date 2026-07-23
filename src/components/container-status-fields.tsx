"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/auth/api-fetch";
import {
  containerStatusLabelMap,
  pumpShortLabelMap
} from "@/lib/domain/options";
import {
  ContainerLookupResponse,
  ContainerStateApiItem
} from "@/types/api";
import { Category, ContainerStatus } from "@/types/domain";

type ContainerFields = {
  category: Category;
  container: string;
  clientId: string;
  containerStatus: ContainerStatus | null;
  containerReason: string;
  startsNewContainerCycle: boolean;
  blendConfirmed: boolean;
  expectedContainerStateVersion: number | null;
};

type LayoutVariant = "compact" | "cards" | "guided";

function isCompleteContainer(value: string): boolean {
  return value.replace(/[^A-Z0-9]/gi, "").length === 11;
}

function isBlend(status: ContainerStatus | null): boolean {
  return status === "BLEND_FULL" || status === "BLEND_PARTIAL";
}

function isPartial(status: ContainerStatus | null): boolean {
  return status === "PARTIAL" || status === "BLEND_PARTIAL";
}

function formatDateTime(value: string): string {
  if (!value) return "-";
  return new Date(value).toLocaleString("pt-BR");
}

function CurrentStateCard({ current }: { current: ContainerStateApiItem }) {
  return (
    <div className="container-current-state">
      <div className="container-current-head">
        <span className={`container-status-badge status-${current.status.toLowerCase()}`}>
          {containerStatusLabelMap[current.status]}
        </span>
        <strong>Estado atual encontrado</strong>
      </div>
      <p>
        {formatDateTime(current.operationalAt)} · {pumpShortLabelMap[current.pump]} ·{" "}
        {current.clientNameSnapshot || "Cliente não identificado"}
      </p>
      <details>
        <summary>Ver detalhes do último lançamento</summary>
        <div className="container-detail-grid">
          <span>
            <strong>Placa</strong>
            {current.plate}
          </span>
          <span>
            <strong>Motivo</strong>
            {current.reason || "—"}
          </span>
          <span>
            <strong>Container</strong>
            {current.container}
          </span>
          <span>
            <strong>Versão</strong>
            {current.version}
          </span>
        </div>
      </details>
    </div>
  );
}

export function ContainerStatusFields({
  fields,
  onChange,
  preserveStatus = false
}: {
  fields: ContainerFields;
  onChange: (patch: Partial<ContainerFields>) => void;
  preserveStatus?: boolean;
}) {
  const [lookup, setLookup] = useState<ContainerLookupResponse | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [variant, setVariant] = useState<LayoutVariant>("cards");
  const onChangeRef = useRef(onChange);
  const isStaging = process.env.NEXT_PUBLIC_APP_ENV === "staging";

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (fields.category !== "PRODUTIVO" || !isCompleteContainer(fields.container)) {
      setLookup(null);
      setLookupError(null);
      onChangeRef.current({ expectedContainerStateVersion: null });
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setLookupError(null);
      try {
        const result = await apiFetch<ContainerLookupResponse>(
          `/api/containers/lookup?container=${encodeURIComponent(fields.container)}`
        );
        if (cancelled) return;
        setLookup(result);
        const patch: Partial<ContainerFields> = {
          expectedContainerStateVersion: result.current?.version ?? 0
        };
        if (
          result.current &&
          isBlend(result.current.status) &&
          !fields.startsNewContainerCycle &&
          !preserveStatus
        ) {
          patch.containerStatus =
            result.current.status === "BLEND_PARTIAL" ? "BLEND_PARTIAL" : "BLEND_FULL";
          patch.blendConfirmed = false;
        }
        onChangeRef.current(patch);
      } catch (error) {
        if (!cancelled) {
          setLookup(null);
          setLookupError(
            error instanceof Error ? error.message : "Não foi possível consultar o container."
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    fields.category,
    fields.container,
    fields.startsNewContainerCycle,
    preserveStatus
  ]);

  const current = lookup?.current ?? null;
  const partial = isPartial(fields.containerStatus);
  const buffer = fields.containerStatus === "BUFFER";
  const blend = isBlend(fields.containerStatus);
  const blendAvailable =
    !fields.startsNewContainerCycle &&
    Boolean(
      current &&
        (current.status === "PARTIAL" ||
          current.status === "BUFFER" ||
          current.status === "BLEND_FULL" ||
          current.status === "BLEND_PARTIAL")
    );
  const blendLocked =
    !fields.startsNewContainerCycle && Boolean(current && isBlend(current.status));
  const reasonRequired =
    fields.containerStatus === "PARTIAL" ||
    fields.containerStatus === "BUFFER" ||
    fields.containerStatus === "BLEND_PARTIAL";

  const layoutClass = `container-status-panel container-layout-${variant}`;

  if (fields.category !== "PRODUTIVO") return null;

  const togglePartial = (checked: boolean) => {
    onChange({
      containerStatus: checked
        ? blend
          ? "BLEND_PARTIAL"
          : "PARTIAL"
        : blend
          ? "BLEND_FULL"
          : "FULL",
      containerReason: checked ? fields.containerReason : ""
    });
  };

  const toggleBuffer = (checked: boolean) => {
    onChange({
      containerStatus: checked ? "BUFFER" : "FULL",
      containerReason: checked ? fields.containerReason : "",
      blendConfirmed: false
    });
  };

  const toggleBlend = (checked: boolean) => {
    if (blendLocked && !checked) return;
    onChange({
      containerStatus: checked
        ? partial
          ? "BLEND_PARTIAL"
          : "BLEND_FULL"
        : partial
          ? "PARTIAL"
          : "FULL",
      blendConfirmed: false
    });
  };

  return (
    <section className={`${layoutClass} col-span-2`}>
      <div className="container-status-heading">
        <div>
          <p className="container-status-kicker">Condição do container</p>
          <h3>Como este container sai deste lançamento?</h3>
        </div>
        <span className="container-live-dot">
          {loading ? "Consultando…" : current ? "Histórico encontrado" : "Novo ciclo"}
        </span>
      </div>

      {isStaging ? (
        <div className="container-layout-switcher" aria-label="Alternativas de layout">
          <span>Design em teste</span>
          {(["compact", "cards", "guided"] as LayoutVariant[]).map((item) => (
            <button
              className={variant === item ? "active" : ""}
              key={item}
              onClick={() => setVariant(item)}
              type="button"
            >
              {item === "compact" ? "Compacto" : item === "cards" ? "Cartões" : "Guiado"}
            </button>
          ))}
        </div>
      ) : null}

      {lookupError ? <div className="notice error">{lookupError}</div> : null}
      {current ? <CurrentStateCard current={current} /> : null}

      {current ? (
        <label className="container-reset-cycle">
          <input
            checked={fields.startsNewContainerCycle}
            onChange={(event) =>
              onChange({
                startsNewContainerCycle: event.target.checked,
                containerStatus: event.target.checked ? "FULL" : fields.containerStatus,
                containerReason: event.target.checked ? "" : fields.containerReason,
                blendConfirmed: false
              })
            }
            type="checkbox"
          />
          <span>
            <strong>O container foi esvaziado</strong>
            <small>Iniciar um novo ciclo sem herdar a carga anterior.</small>
          </span>
        </label>
      ) : null}

      {lookup?.requiresNewCycleConfirmation && !fields.startsNewContainerCycle ? (
        <div className="notice warn">
          Este container estava {current?.status === "BLEND_FULL" ? "com Blend cheio" : "cheio"}.
          Confirme o esvaziamento antes de iniciar outro carregamento.
        </div>
      ) : null}

      <div className="container-state-choices">
        <label className={`container-state-choice ${partial ? "active" : ""}`}>
          <input
            checked={partial}
            disabled={buffer}
            onChange={(event) => togglePartial(event.target.checked)}
            type="checkbox"
          />
          <span>
            <strong>Parcial</strong>
            <small>Ainda receberá carga.</small>
          </span>
        </label>

        <label className={`container-state-choice ${buffer ? "active" : ""}`}>
          <input
            checked={buffer}
            disabled={blend}
            onChange={(event) => toggleBuffer(event.target.checked)}
            type="checkbox"
          />
          <span>
            <strong>Pulmão</strong>
            <small>Armazenamento temporário.</small>
          </span>
        </label>

        {blendAvailable ? (
          <label className={`container-state-choice blend ${blend ? "active" : ""}`}>
            <input
              checked={blend}
              disabled={blendLocked}
              onChange={(event) => toggleBlend(event.target.checked)}
              type="checkbox"
            />
            <span>
              <strong>Blend</strong>
              <small>Mistura com a carga anterior.</small>
            </span>
          </label>
        ) : null}
      </div>

      <p className="container-result-line">
        Resultado:{" "}
        <strong>
          {containerStatusLabelMap[fields.containerStatus || "FULL"]}
        </strong>
      </p>

      {reasonRequired ? (
        <label className="field-label">
          Motivo *
          <textarea
            className="textarea-ui"
            onChange={(event) => onChange({ containerReason: event.target.value })}
            placeholder={
              buffer
                ? "Explique por que a carga ficará temporariamente neste container."
                : "Explique por que o container ficará parcial."
            }
            required
            value={fields.containerReason}
          />
        </label>
      ) : null}

      {blend ? (
        <label className="container-blend-confirm">
          <input
            checked={fields.blendConfirmed}
            onChange={(event) => onChange({ blendConfirmed: event.target.checked })}
            required
            type="checkbox"
          />
          <span>
            <strong>Confirmo que este carregamento formará um Blend</strong>
            <small>
              A placa atual ficará vinculada às placas anteriores deste ciclo.
            </small>
          </span>
        </label>
      ) : null}
    </section>
  );
}
