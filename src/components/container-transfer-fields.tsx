"use client";

import { useEffect, useId, useRef, useState } from "react";
import { apiFetch } from "@/lib/auth/api-fetch";
import {
  identifyLoadSource,
  isTransferSourceStatus,
  originCode
} from "@/lib/domain/container-transfer";
import {
  ContainerLookupResponse,
  ContainerStateApiItem,
  PaginatedResponse
} from "@/types/api";
import { LoadSourceType } from "@/types/domain";

type TransferFields = {
  originInput: string;
  loadSourceType: LoadSourceType;
  sourceContainer: string;
  sourceContainerEmptied: boolean | null;
  expectedSourceContainerStateVersion: number | null;
  expectedSourceContainerCycleId: string | null;
  clientId: string;
  plate: string;
  container: string;
};

type SearchPage = {
  key: string;
  items: ContainerStateApiItem[];
  nextCursor: string | null;
  error: string | null;
};

export function ContainerTransferFields({
  fields,
  onChange,
  enabled,
  isEditing
}: {
  fields: TransferFields;
  onChange: (patch: Partial<TransferFields>, expectedOrigin?: string) => void;
  enabled: boolean;
  isEditing: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [page, setPage] = useState<SearchPage | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const request = useRef<AbortController | null>(null);
  const kind = identifyLoadSource(fields.originInput);
  const key = JSON.stringify([
    originCode(fields.originInput),
    originCode(fields.container),
    retry
  ]);
  const selected = Boolean(fields.sourceContainer);
  const selectedStatus = page?.items.find(
    (item) => item.container === fields.sourceContainer
  )?.status;
  const searching = enabled && kind === "BUFFER_CONTAINER" && !selected;
  const ready = page?.key === key;
  const items = ready ? page.items : [];
  const error = ready ? page.error : null;
  const loading = searching && !ready;
  const same =
    kind === "BUFFER_CONTAINER" &&
    originCode(fields.originInput) === originCode(fields.container);

  useEffect(() => {
    if (!searching) return;
    const controller = new AbortController();
    request.current = controller;
    const [query, excluded] = JSON.parse(key) as [string, string];
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          scope: "transfer-source",
          query,
          excludeContainer: excluded,
          limit: "20"
        });
        const response = await apiFetch<
          PaginatedResponse<ContainerStateApiItem>
        >(`/api/containers?${params}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setPage({
          key,
          items: response.items,
          nextCursor: response.nextCursor,
          error: null
        });
      } catch (reason) {
        if (controller.signal.aborted) return;
        setPage({
          key,
          items: [],
          nextCursor: null,
          error:
            reason instanceof Error
              ? reason.message
              : "Não foi possível consultar os containers."
        });
      }
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [key, searching]);

  async function loadMore() {
    const controller = request.current;
    if (
      !ready ||
      !page.nextCursor ||
      !controller ||
      controller.signal.aborted ||
      loadingMore
    )
      return;
    const cursor = page.nextCursor;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({
        scope: "transfer-source",
        query: originCode(fields.originInput),
        excludeContainer: originCode(fields.container),
        limit: "20",
        cursor
      });
      const response = await apiFetch<PaginatedResponse<ContainerStateApiItem>>(
        `/api/containers?${params}`,
        { signal: controller.signal }
      );
      if (controller.signal.aborted) return;
      setPage((current) =>
        current?.key === key
          ? {
              key,
              items: Array.from(
                new Map(
                  [...current.items, ...response.items].map((item) => [
                    item.container,
                    item
                  ])
                ).values()
              ),
              nextCursor:
                response.nextCursor === cursor ? null : response.nextCursor,
              error: null
            }
          : current
      );
    } catch (reason) {
      if (!controller.signal.aborted)
        setPage((current) =>
          current?.key === key
            ? {
                ...current,
                error:
                  reason instanceof Error
                    ? reason.message
                    : "Não foi possível carregar mais containers."
              }
            : current
        );
    } finally {
      setLoadingMore(false);
    }
  }

  function select(item: ContainerStateApiItem) {
    if (
      !enabled ||
      !isTransferSourceStatus(item.status) ||
      originCode(item.container) === originCode(fields.container)
    )
      return;
    setOpen(false);
    setActive(-1);
    onChange({
      originInput: item.container,
      loadSourceType: "BUFFER_CONTAINER",
      plate: "",
      sourceContainer: item.container,
      sourceContainerEmptied: null,
      expectedSourceContainerStateVersion: item.version,
      expectedSourceContainerCycleId: item.cycleId,
      clientId: item.clientId
    });
  }

  return (
    <div className="origin-fields col-span-2">
      <div className="origin-label-row">
        <label className="field-label" htmlFor={id}>
          Placa ou container de origem *
        </label>
        <span className="origin-detected" role="status">
          {kind === "BUFFER_CONTAINER"
            ? "Container identificado"
            : kind === "TRUCK"
              ? "Carreta identificada"
              : "A identificar"}
        </span>
      </div>
      <div
        className="relative"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget))
            setOpen(false);
        }}
      >
        <input
          id={id}
          className="input-ui"
          value={fields.originInput}
          onChange={(event) => {
            const value = event.target.value;
            const nextKind = identifyLoadSource(value);
            setActive(-1);
            setOpen(nextKind === "BUFFER_CONTAINER");
            onChange({
              originInput: value,
              loadSourceType: nextKind || "TRUCK",
              plate: nextKind === "BUFFER_CONTAINER" ? "" : value,
              clientId:
                selected || nextKind === "BUFFER_CONTAINER"
                  ? ""
                  : fields.clientId,
              sourceContainer: "",
              sourceContainerEmptied: null,
              expectedSourceContainerStateVersion: null,
              expectedSourceContainerCycleId: null
            });
          }}
          onFocus={() => {
            if (searching) setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setOpen(false);
              return;
            }
            if (!searching) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
              setActive((current) =>
                items.length
                  ? event.key === "ArrowDown"
                    ? Math.min(current + 1, items.length - 1)
                    : Math.max(current - 1, 0)
                  : -1
              );
            }
            if (event.key === "Enter" && open) {
              event.preventDefault();
              if (!loading && !error && items[active]) select(items[active]);
            }
          }}
          role={kind === "BUFFER_CONTAINER" ? "combobox" : undefined}
          aria-expanded={
            kind === "BUFFER_CONTAINER" ? open && searching : undefined
          }
          aria-controls={
            kind === "BUFFER_CONTAINER" ? `${id}-options` : undefined
          }
          aria-autocomplete={kind === "BUFFER_CONTAINER" ? "list" : undefined}
          aria-activedescendant={
            open && searching && !loading && !error && items[active]
              ? `${id}-option-${active}`
              : undefined
          }
          aria-describedby={`${id}-hint`}
          aria-invalid={same || undefined}
          autoComplete="off"
          spellCheck={false}
          required
          placeholder="Placa ou código do container"
        />
        {open && searching ? (
          <div className="origin-options">
            <div
              id={`${id}-options`}
              role="listbox"
              aria-label="Containers de origem"
              aria-busy={loading || loadingMore}
            >
              {loading ? (
                <p role="status">Consultando containers…</p>
              ) : (
                items.map((item, index) => (
                  <button
                    key={item.container}
                    id={`${id}-option-${index}`}
                    type="button"
                    role="option"
                    aria-selected={active === index}
                    className={active === index ? "active" : ""}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => select(item)}
                  >
                    <span>
                      <strong>{item.container}</strong>
                      <small>{item.clientNameSnapshot || "Sem cliente"}</small>
                    </span>
                    <span
                      className={`container-status-badge status-${item.status.toLowerCase()}`}
                    >
                      {item.status === "BUFFER" ? "Pulmão" : "Parcial"}
                    </span>
                  </button>
                ))
              )}
            </div>
            {!loading && !error && !items.length ? (
              <p role="status">
                {page?.nextCursor
                  ? "Nenhum resultado nesta página."
                  : "Nenhum Pulmão ou Parcial aberto foi encontrado."}
              </p>
            ) : null}
            {error ? (
              <div>
                <p role="alert">{error}</p>
                <button
                  type="button"
                  className="btn-soft"
                  onClick={() => {
                    setActive(-1);
                    setRetry((value) => value + 1);
                  }}
                >
                  Tentar novamente
                </button>
              </div>
            ) : null}
            {ready && page.nextCursor && !error ? (
              <button
                type="button"
                className="btn-soft"
                onClick={() => void loadMore()}
                disabled={loadingMore}
              >
                {loadingMore ? "Carregando…" : "Carregar mais"}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      <p id={`${id}-hint`} className="origin-hint">
        {kind === "BUFFER_CONTAINER" && !enabled
          ? "Transferências entre containers estão temporariamente indisponíveis."
          : selected
            ? `Origem selecionada${selectedStatus ? ` · ${selectedStatus === "BUFFER" ? "Pulmão" : "Parcial"}` : ""}`
            : kind === "BUFFER_CONTAINER"
              ? "Selecione um container Pulmão ou Parcial em aberto."
              : "Digite a placa ou comece pelas quatro letras do container."}
      </p>
      {same ? (
        <p role="alert" className="notice error mt-2">
          Origem e destino precisam ser containers diferentes.
        </p>
      ) : null}
      {selected && enabled && isEditing ? (
        <div className="mt-2">
          <button
            type="button"
            className="origin-refresh"
            disabled={refreshing}
            onClick={async () => {
              const origin = fields.originInput;
              setRefreshing(true);
              setRefreshError(null);
              try {
                const response = await apiFetch<ContainerLookupResponse>(
                  `/api/containers/lookup?container=${encodeURIComponent(fields.sourceContainer)}`
                );
                onChange(
                  {
                    expectedSourceContainerStateVersion:
                      response.current?.version ?? 0,
                    sourceContainerEmptied: null
                  },
                  origin
                );
              } catch (reason) {
                setRefreshError(
                  reason instanceof Error
                    ? reason.message
                    : "Não foi possível atualizar o estado da origem."
                );
              } finally {
                setRefreshing(false);
              }
            }}
          >
            {refreshing ? "Atualizando…" : "Atualizar estado da origem"}
          </button>
          {refreshError ? (
            <p className="notice error" role="alert">
              {refreshError}
            </p>
          ) : null}
        </div>
      ) : null}
      {selected ? (
        <fieldset className="origin-empty" disabled={!enabled}>
          <legend className="field-label">
            O container de origem foi completamente esvaziado? *
          </legend>
          <div className="origin-empty-options">
            {[
              { value: true, label: "Sim, foi esvaziado" },
              { value: false, label: "Não, restará carga" }
            ].map((option) => (
              <label
                key={String(option.value)}
                className={`container-state-choice ${fields.sourceContainerEmptied === option.value ? "active" : ""}`}
              >
                <input
                  type="radio"
                  required
                  name={`${id}-emptied`}
                  checked={fields.sourceContainerEmptied === option.value}
                  onChange={() =>
                    onChange({ sourceContainerEmptied: option.value })
                  }
                />
                <span>
                  <strong>{option.label}</strong>
                </span>
              </label>
            ))}
          </div>
          {fields.sourceContainerEmptied !== null ? (
            <p className="origin-hint" role="status">
              {fields.sourceContainerEmptied
                ? "A origem será esvaziada e o ciclo encerrado."
                : selectedStatus
                  ? `A origem continuará como ${selectedStatus === "BUFFER" ? "Pulmão" : "Parcial"}.`
                  : "A origem manterá seu estado anterior."}
            </p>
          ) : null}
        </fieldset>
      ) : null}
    </div>
  );
}
