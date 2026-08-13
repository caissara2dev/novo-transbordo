"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/auth/api-fetch";
import { formatContainerForInput } from "@/lib/domain/identifiers";
import {
  ContainerLookupResponse,
  ContainerStateApiItem,
  PaginatedResponse
} from "@/types/api";
import { LoadSourceType } from "@/types/domain";

type TransferFields = {
  loadSourceType: LoadSourceType;
  sourceContainer: string;
  sourceContainerEmptied: boolean | null;
  expectedSourceContainerStateVersion: number | null;
  clientId: string;
  plate: string;
  container: string;
};

type ContainerTransferFieldsProps = {
  fields: TransferFields;
  onChange: (patch: Partial<TransferFields>) => void;
};

async function fetchBufferContainers(params: {
  query: string;
  signal: AbortSignal;
  cursor?: string;
  accumulated?: ContainerStateApiItem[];
  visitedCursors?: string[];
}): Promise<ContainerStateApiItem[]> {
  const searchParams = new URLSearchParams({
    scope: "open",
    status: "BUFFER",
    query: params.query.trim(),
    limit: "200"
  });
  if (params.cursor) searchParams.set("cursor", params.cursor);

  const response = await apiFetch<PaginatedResponse<ContainerStateApiItem>>(
    `/api/containers?${searchParams.toString()}`,
    { signal: params.signal }
  );
  const accumulated = params.accumulated || [];
  const merged = [
    ...accumulated,
    ...(response.items || []).filter(
      (item) =>
        item.status === "BUFFER" &&
        !accumulated.some((current) => current.container === item.container)
    )
  ];
  const nextCursor = response.nextCursor;
  const visitedCursors = params.visitedCursors || [];
  if (!nextCursor || visitedCursors.includes(nextCursor)) return merged;

  return fetchBufferContainers({
    ...params,
    cursor: nextCursor,
    accumulated: merged,
    visitedCursors: [...visitedCursors, nextCursor]
  });
}

export function ContainerTransferFields({
  fields,
  onChange
}: ContainerTransferFieldsProps) {
  const [query, setQuery] = useState(fields.sourceContainer);
  const [items, setItems] = useState<ContainerStateApiItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedQuery, setLoadedQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const onChangeRef = useRef(onChange);
  const comboboxId = useId();
  const listboxId = `${comboboxId}-listbox`;

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (fields.loadSourceType !== "BUFFER_CONTAINER") {
      return;
    }

    const controller = new AbortController();
    const fetchQuery = query.trim();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const candidates = await fetchBufferContainers({
          query,
          signal: controller.signal
        });
        if (controller.signal.aborted) return;
        setItems(candidates);
        setLoadedQuery(fetchQuery);
        setActiveIndex(candidates.length ? 0 : -1);
      } catch (reason) {
        if (controller.signal.aborted) return;
        setItems([]);
        setLoadedQuery(fetchQuery);
        setError(
          reason instanceof Error
            ? reason.message
            : "Não foi possível consultar os containers pulmão."
        );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 250);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [fields.loadSourceType, query]);

  useEffect(() => {
    if (
      fields.loadSourceType !== "BUFFER_CONTAINER" ||
      !fields.sourceContainer
    ) {
      return;
    }

    const controller = new AbortController();
    void apiFetch<ContainerLookupResponse>(
      `/api/containers/lookup?container=${encodeURIComponent(fields.sourceContainer)}`,
      { signal: controller.signal }
    )
      .then((response) => {
        if (
          !controller.signal.aborted &&
          response.current &&
          response.current.version !== fields.expectedSourceContainerStateVersion
        ) {
          onChangeRef.current({
            expectedSourceContainerStateVersion: response.current.version
          });
        }
      })
      .catch((reason) => {
        if (controller.signal.aborted) return;
        setError(
          reason instanceof Error
            ? reason.message
            : "Não foi possível atualizar o estado do container de origem."
        );
      });

    return () => controller.abort();
  }, [
    fields.expectedSourceContainerStateVersion,
    fields.loadSourceType,
    fields.sourceContainer
  ]);

  const candidates = useMemo(() => {
    if (
      !fields.sourceContainer ||
      items.some((item) => item.container === fields.sourceContainer)
    ) {
      return items;
    }

    return [
      {
        container: fields.sourceContainer,
        clientId: fields.clientId,
        clientNameSnapshot: "Container selecionado",
        version: fields.expectedSourceContainerStateVersion ?? 0,
        status: "BUFFER" as const
      } as ContainerStateApiItem,
      ...items
    ];
  }, [
    fields.clientId,
    fields.expectedSourceContainerStateVersion,
    fields.sourceContainer,
    items
  ]);

  const sameContainer =
    fields.loadSourceType === "BUFFER_CONTAINER" &&
    Boolean(fields.sourceContainer) &&
    formatContainerForInput(fields.sourceContainer) ===
      formatContainerForInput(fields.container);

  const selectSource = (selected: ContainerStateApiItem) => {
    setQuery(selected.container);
    setOpen(false);
    onChangeRef.current({
      sourceContainer: selected.container,
      sourceContainerEmptied: null,
      expectedSourceContainerStateVersion: selected.version,
      clientId: selected.clientId
    });
  };

  const clearSelectedSource = (nextQuery: string) => {
    if (
      fields.sourceContainer &&
      formatContainerForInput(fields.sourceContainer) !==
        formatContainerForInput(nextQuery)
    ) {
      onChangeRef.current({
        sourceContainer: "",
        sourceContainerEmptied: null,
        expectedSourceContainerStateVersion: null,
        clientId: ""
      });
    }
  };

  return (
    <fieldset className="col-span-2 space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
      <legend className="px-1 text-sm font-extrabold text-slate-700">
        Origem da carga
      </legend>
      <div className="grid gap-2 sm:grid-cols-2">
        <label
          className={`container-state-choice ${
            fields.loadSourceType === "TRUCK" ? "active" : ""
          }`}
        >
          <input
            checked={fields.loadSourceType === "TRUCK"}
            name="load-source-type"
            onChange={() => {
              setQuery("");
              setItems([]);
              setError(null);
              setLoadedQuery(null);
              setOpen(false);
              onChangeRef.current({
                loadSourceType: "TRUCK",
                sourceContainer: "",
                sourceContainerEmptied: null,
                expectedSourceContainerStateVersion: null
              });
            }}
            type="radio"
          />
          <span>
            <strong>Carreta</strong>
            <small>A carga chega em um veículo.</small>
          </span>
        </label>
        <label
          className={`container-state-choice ${
            fields.loadSourceType === "BUFFER_CONTAINER" ? "active" : ""
          }`}
        >
          <input
            checked={fields.loadSourceType === "BUFFER_CONTAINER"}
            name="load-source-type"
            onChange={() => {
              setQuery("");
              setItems([]);
              setError(null);
              setLoadedQuery(null);
              setOpen(false);
              onChangeRef.current({
                loadSourceType: "BUFFER_CONTAINER",
                plate: "",
                clientId: "",
                sourceContainer: "",
                sourceContainerEmptied: null,
                expectedSourceContainerStateVersion: null
              });
            }}
            type="radio"
          />
          <span>
            <strong>Container pulmão</strong>
            <small>A carga vem de outro container aberto.</small>
          </span>
        </label>
      </div>

      {fields.loadSourceType === "BUFFER_CONTAINER" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div
            className="relative sm:col-span-2"
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) {
                setOpen(false);
              }
            }}
          >
            <label className="field-label" htmlFor={comboboxId}>
              Container de origem *
            </label>
            <input
              aria-activedescendant={
                open && candidates[activeIndex]
                  ? `${listboxId}-option-${activeIndex}`
                  : undefined
              }
              aria-autocomplete="list"
              aria-controls={listboxId}
              aria-expanded={open}
              className="input-ui"
              id={comboboxId}
              onChange={(event) => {
                const nextQuery = formatContainerForInput(event.target.value);
                setQuery(nextQuery);
                setLoadedQuery(null);
                setOpen(true);
                setActiveIndex(0);
                clearSelectedSource(nextQuery);
              }}
              onFocus={() => {
                setOpen(true);
                setActiveIndex(candidates.length ? 0 : -1);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setOpen(false);
                  return;
                }
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setOpen(true);
                  setActiveIndex((current) =>
                    candidates.length
                      ? Math.min(current + 1, candidates.length - 1)
                      : -1
                  );
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setActiveIndex((current) =>
                    candidates.length ? Math.max(current - 1, 0) : -1
                  );
                  return;
                }
                if (event.key === "Enter" && candidates[activeIndex]) {
                  event.preventDefault();
                  selectSource(candidates[activeIndex]);
                }
              }}
              placeholder="Digite ou selecione um Pulmão"
              required
              role="combobox"
              type="search"
              value={query}
            />
            {open ? (
              <div
                className="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-xl border border-slate-200 bg-white p-1 shadow-lg"
                id={listboxId}
                role="listbox"
              >
                {loading || loadedQuery !== query.trim() ? (
                  <p className="px-3 py-2 text-sm text-slate-500">
                    Consultando…
                  </p>
                ) : null}
                {!loading &&
                loadedQuery === query.trim() &&
                !error &&
                !candidates.length ? (
                  <p className="px-3 py-2 text-sm text-slate-500">
                    Nenhum container Pulmão aberto foi encontrado.
                  </p>
                ) : null}
                {!loading
                  ? candidates.map((item, index) => (
                      <button
                        aria-selected={fields.sourceContainer === item.container}
                        className={`block w-full rounded-lg px-3 py-2 text-left text-sm ${
                          activeIndex === index
                            ? "bg-slate-100 text-slate-950"
                            : "bg-white text-slate-700"
                        }`}
                        id={`${listboxId}-option-${index}`}
                        key={item.container}
                        onClick={() => selectSource(item)}
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseEnter={() => setActiveIndex(index)}
                        role="option"
                        type="button"
                      >
                        <strong>{item.container}</strong>
                        <span className="ml-2 text-slate-500">
                          {item.clientNameSnapshot || "Sem cliente"}
                        </span>
                      </button>
                    ))
                  : null}
              </div>
            ) : null}
          </div>
          {error ? (
            <div className="notice error sm:col-span-2">{error}</div>
          ) : null}
          {fields.sourceContainer ? (
            <fieldset className="space-y-2 sm:col-span-2">
              <legend className="field-label">
                O container de origem foi completamente esvaziado? *
              </legend>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="container-state-choice">
                  <input
                    checked={fields.sourceContainerEmptied === true}
                    name="source-container-emptied"
                    onChange={() =>
                      onChangeRef.current({ sourceContainerEmptied: true })
                    }
                    required
                    type="radio"
                  />
                  <span>
                    <strong>Sim, foi esvaziado</strong>
                    <small>O pulmão será encerrado.</small>
                  </span>
                </label>
                <label className="container-state-choice">
                  <input
                    checked={fields.sourceContainerEmptied === false}
                    name="source-container-emptied"
                    onChange={() =>
                      onChangeRef.current({ sourceContainerEmptied: false })
                    }
                    required
                    type="radio"
                  />
                  <span>
                    <strong>Não, continuará como pulmão</strong>
                    <small>Ainda restará carga no container.</small>
                  </span>
                </label>
              </div>
            </fieldset>
          ) : null}
          {sameContainer ? (
            <div className="notice error sm:col-span-2" role="alert">
              Origem e destino precisam ser containers diferentes.
            </div>
          ) : null}
        </div>
      ) : null}
    </fieldset>
  );
}
