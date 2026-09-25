"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/auth/api-fetch";
import { RoleGuard } from "@/components/role-guard";
import { isAbortError } from "@/lib/ui/latest-request";
import { ClientApiItem } from "@/types/api";

export default function ClientsPage() {
  const [clients, setClients] = useState<ClientApiItem[]>([]);
  const [name, setName] = useState("");
  const [includeInactive, setIncludeInactive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const fetchClients = useCallback(async (signal?: AbortSignal) => {
    const data = await apiFetch<{ items: ClientApiItem[] }>(
      `/api/clients?includeInactive=${includeInactive ? "true" : "false"}`,
      { signal }
    );

    return data.items || [];
  }, [includeInactive]);

  useEffect(() => {
    const controller = new AbortController();

    void fetchClients(controller.signal)
      .then((nextClients) => {
        if (!controller.signal.aborted) {
          setClients(nextClients);
        }
      })
      .catch((reason) => {
        if (!controller.signal.aborted && !isAbortError(reason)) {
          setError(reason instanceof Error ? reason.message : "Erro ao carregar clientes.");
        }
      });

    return () => controller.abort();
  }, [fetchClients]);

  const createClient = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setMessage(null);
    setPending(true);

    try {
      await apiFetch<{ item: ClientApiItem }>("/api/clients", {
        method: "POST",
        body: JSON.stringify({ name })
      });
      setName("");
      setMessage("Cliente criado com sucesso.");
      setClients(await fetchClients());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao criar cliente.");
    } finally {setPending(false);}
  };

  const updateClient = async (client: ClientApiItem, patch: {active?: boolean; portalEnabled?: boolean; usesSample?: boolean}) => {
    setError(null);setMessage(null);setPending(true);
    try {
      const result = await apiFetch<{item: ClientApiItem}>(`/api/clients/${client.id}`, {
        method: "PATCH", body: JSON.stringify({...patch, expectedVersion: client.accessVersion ?? 0})
      });
      setClients(current => current.map(item => item.id === client.id ? result.item : item).filter(item => includeInactive || item.active));
      setMessage(`Configuração de ${client.name} salva. As visitas existentes foram preservadas.`);
    } catch (err) {setError(err instanceof Error ? err.message : "Erro ao atualizar cliente.");}
    finally {setPending(false);}
  };
  async function refresh() {
    setError(null);setPending(true);
    try {setClients(await fetchClients());} catch(err) {setError(err instanceof Error ? err.message : "Erro ao carregar clientes.");}
    finally {setPending(false);}
  }

  return (
    <RoleGuard allowed={["ADMIN"]}>
      <section className="space-y-5">
        <header>
          <p className="pill">Admin</p>
          <h1 className="panel-title mt-2 text-3xl">Clientes</h1>
          <p className="text-sm muted">Cadastro, participação no portal e uso de amostra.</p>
          <p className="text-sm muted mt-2">Vincule e aprove as contas em <Link className="underline" href="/users">Usuários</Link>. Habilitar o portal não aprova contas automaticamente.</p>
        </header>

        {error ? <div role="alert" className="notice error">{error}</div> : null}
        {message ? <div role="status" className="notice success">{message}</div> : null}

        <form className="panel flex flex-wrap items-end gap-2" onSubmit={createClient}>
          <input
            aria-label="Nome do cliente"
            disabled={pending}
            className="input-ui min-w-60"
            onChange={(e) => setName(e.target.value)}
            placeholder="Nome do cliente"
            required
            value={name}
          />
          <button className="btn-primary" disabled={pending} type="submit">
            Adicionar
          </button>
          <label className="ml-2 inline-flex items-center gap-2 text-sm muted">
            <input
              disabled={pending}
              checked={includeInactive}
              onChange={(e) => setIncludeInactive(e.target.checked)}
              type="checkbox"
            />
            Mostrar inativos
          </label>
        </form>

        <div className="flex items-center justify-between gap-3">
          <p className="text-sm muted">Cada opção salva ao ser alterada. Desativar amostra preserva os valores já registrados e não libera cargas.</p>
          <button type="button" className="btn-soft" disabled={pending} onClick={() => void refresh()}>Atualizar lista</button>
        </div>
        <div className="space-y-2">
          {clients.map((client) => (
            <article aria-label={`Configuração de ${client.name}`} className="panel flex flex-wrap items-center justify-between gap-4" key={client.id}>
              <div>
                <p className="font-medium">{client.name}</p>
                <p className="text-xs muted">{client.active ? "Ativo" : "Inativo"}</p>
              </div>
              <div className="flex flex-wrap items-center gap-4">
                <label className="inline-flex items-center gap-2 text-sm"><input type="checkbox" disabled={pending}
                  checked={client.portalEnabled === true} onChange={e => void updateClient(client, {portalEnabled: e.target.checked})}/> Acesso ao portal</label>
                <label className="inline-flex items-center gap-2 text-sm"><input type="checkbox" disabled={pending}
                  checked={client.usesSample !== false} onChange={e => void updateClient(client, {usesSample: e.target.checked})}/> Usa amostra</label>
              <button
                disabled={pending}
                className={client.active ? "btn-danger" : "btn-soft"}
                onClick={() => void updateClient(client, {active: !client.active})}
                type="button"
              >
                {client.active ? "Inativar" : "Ativar"}
              </button>
              </div>
            </article>
          ))}

          {!clients.length ? <p className="text-sm muted">Sem clientes cadastrados.</p> : null}
        </div>
      </section>
    </RoleGuard>
  );
}
