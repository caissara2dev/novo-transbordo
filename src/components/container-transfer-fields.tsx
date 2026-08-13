"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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

export function ContainerTransferFields({
  fields,
  onChange
}: ContainerTransferFieldsProps) {
  const [query, setQuery] = useState(fields.sourceContainer);
  const [items, setItems] = useState<ContainerStateApiItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (fields.loadSourceType !== "BUFFER_CONTAINER") {
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError(null);
      const searchParams = new URLSearchParams({
        scope: "open",
        status: "BUFFER",
        query: query.trim()
      });

      try {
        const response = await apiFetch<
          PaginatedResponse<ContainerStateApiItem>
        >(`/api/containers?${searchParams.toString()}`, {
          signal: controller.signal
        });
        if (controller.signal.aborted) return;

        setItems(
          (response.items || []).filter((item) => item.status === "BUFFER")
        );
      } catch (reason) {
        if (controller.signal.aborted) return;
        setItems([]);
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

  const selectSource = (container: string) => {
    const selected = candidates.find((item) => item.container === container);
    onChangeRef.current({
      sourceContainer: selected?.container || "",
      sourceContainerEmptied: null,
      expectedSourceContainerStateVersion: selected?.version ?? null,
      clientId: selected?.clientId || ""
    });
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
            onChange={() =>
              onChangeRef.current({
                loadSourceType: "BUFFER_CONTAINER",
                plate: "",
                clientId: "",
                sourceContainer: "",
                sourceContainerEmptied: null,
                expectedSourceContainerStateVersion: null
              })
            }
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
          <label className="field-label">
            Buscar container pulmão
            <input
              className="input-ui"
              onChange={(event) =>
                setQuery(formatContainerForInput(event.target.value))
              }
              placeholder="ABCU1234560"
              type="search"
              value={query}
            />
          </label>
          <label className="field-label">
            Container de origem *
            <select
              className="select-ui"
              disabled={loading}
              onChange={(event) => selectSource(event.target.value)}
              required
              value={fields.sourceContainer}
            >
              <option value="">
                {loading ? "Consultando…" : "Selecione um pulmão"}
              </option>
              {candidates.map((item) => (
                <option key={item.container} value={item.container}>
                  {item.container} · {item.clientNameSnapshot || "Sem cliente"}
                </option>
              ))}
            </select>
          </label>
          {error ? <div className="notice error sm:col-span-2">{error}</div> : null}
          {!loading && !error && !candidates.length ? (
            <p className="text-sm text-slate-500 sm:col-span-2">
              Nenhum container pulmão aberto foi encontrado.
            </p>
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
