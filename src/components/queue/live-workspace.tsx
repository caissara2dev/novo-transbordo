"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/auth/api-fetch";
import { useAuthSession } from "@/lib/auth/use-auth-session";
import { InvoiceSummary } from "./invoice-summary";
import { documentBlocksCall } from "@/lib/domain/checkin-document";
import { QueueWorkspace } from "./workspace";
import { queueCsv } from "@/lib/domain/queue";
import type { QueueClient, QueueVisit, QueueCommand } from "@/lib/domain/queue";
type Page = {
  items: QueueVisit[];
  clients: QueueClient[];
  nextCursor: string | null;
};
export function LiveQueue({ customer = false }: { customer?: boolean }) {
  const { profile } = useAuthSession();
  const [visits, setVisits] = useState<QueueVisit[]>([]);
  const [clients, setClients] = useState<QueueClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const request = useRef(0);
  const base = customer ? "/api/customer/checkins" : "/api/checkins";
  const load = useCallback(
    async (signal?: AbortSignal) => {
      let cursor: string | null = null;
      const items: QueueVisit[] = [];
      let choices: QueueClient[] = [];
      const seen = new Set<string>();
      do {
        const page: Page = await apiFetch(
          `${base}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
          { signal, cache: "no-store" },
        );
        items.push(...page.items);
        choices = page.clients;
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor))
          throw new Error(
            "A fila mudou durante a consulta. Atualize novamente.",
          );
        if (cursor) seen.add(cursor);
      } while (cursor);
      setVisits([...new Map(items.map((v) => [v.id, v])).values()]);
      setClients(choices);
    },
    [base],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal)
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "Falha ao carregar fila.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [load]);
  const inspect = useCallback(
    async (id: string) => {
      const token = ++request.current;
      const { item } = await apiFetch<{ item: QueueVisit }>(
        `${base}/${encodeURIComponent(id)}`,
        { cache: "no-store" },
      );
      if (token === request.current)
        setVisits((list) =>
          list.map((v) =>
            v.id === item.id && item.version === v.version
              ? { ...v, revisions: item.revisions, location: item.location, document:item.document }
              : v,
          ),
        );
    },
    [base],
  );
  async function command(id: string, version: number, command: QueueCommand) {
    ++request.current;
    const { item } = await apiFetch<{ item: QueueVisit }>(
      `${base}/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ expectedVersion: version, command }),
      },
    );
    setVisits((list) => list.map((v) => (v.id === item.id ? item : v)));
  }
  const ownClient = customer
    ? clients.find((c) => c.id === profile?.clientId)
    : undefined;
  if (loading)
    return (
      <div role="status" className="panel">
        Carregando fila…
      </div>
    );
  if (error || (customer && !ownClient))
    return (
      <div role="alert" className="notice error">
        {error || "Acesso do cliente não habilitado."}
        <button
          className="btn-soft"
          onClick={() => {
            setError("");
            void load().catch((e) => setError(e.message));
          }}
        >
          Tentar novamente
        </button>
      </div>
    );
  return (
    <QueueWorkspace
      visits={visits}
      renderVisitSupplement={customer?undefined:(visit)=><InvoiceSummary key={visit.id} visit={visit} />}
      isReleaseBlocked={(visit)=>documentBlocksCall(visit.document)}
      clients={clients}
      customer={ownClient}
      onCommand={command}
      onInspect={inspect}
      onRefresh={load}
      onExport={async (rows) => {
        const url = URL.createObjectURL(
          new Blob([queueCsv(rows)], { type: "text/csv;charset=utf-8" }),
        );
        const link = document.createElement("a");
        link.href = url;
        link.download = `fila-${new Date().toISOString().slice(0, 10)}.csv`;
        link.click();
        URL.revokeObjectURL(url);
      }}
    />
  );
}
