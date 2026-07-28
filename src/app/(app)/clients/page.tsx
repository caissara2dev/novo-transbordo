"use client";

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
    }
  };

  const toggleClient = async (client: ClientApiItem) => {
    setError(null);

    try {
      await apiFetch(`/api/clients/${client.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: !client.active })
      });
      setClients(await fetchClients());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao atualizar cliente.");
    }
  };

  return (
    <RoleGuard allowed={["ADMIN"]}>
      <section className="space-y-5">
        <header>
          <p className="pill">Admin</p>
          <h1 className="panel-title mt-2 text-3xl">Clientes</h1>
          <p className="text-sm muted">Cadastro e controle de clientes ativos.</p>
        </header>

        {error ? <div className="notice error">{error}</div> : null}
        {message ? <div className="notice success">{message}</div> : null}

        <form className="panel flex flex-wrap items-end gap-2" onSubmit={createClient}>
          <input
            className="input-ui min-w-60"
            onChange={(e) => setName(e.target.value)}
            placeholder="Nome do cliente"
            required
            value={name}
          />
          <button className="btn-primary" type="submit">
            Adicionar
          </button>
          <label className="ml-2 inline-flex items-center gap-2 text-sm muted">
            <input
              checked={includeInactive}
              onChange={(e) => setIncludeInactive(e.target.checked)}
              type="checkbox"
            />
            Mostrar inativos
          </label>
        </form>

        <div className="space-y-2">
          {clients.map((client) => (
            <div className="panel flex items-center justify-between" key={client.id}>
              <div>
                <p className="font-medium">{client.name}</p>
                <p className="text-xs muted">{client.active ? "Ativo" : "Inativo"}</p>
              </div>
              <button
                className={client.active ? "btn-danger" : "btn-soft"}
                onClick={() => toggleClient(client)}
                type="button"
              >
                {client.active ? "Inativar" : "Ativar"}
              </button>
            </div>
          ))}

          {!clients.length ? <p className="text-sm muted">Sem clientes cadastrados.</p> : null}
        </div>
      </section>
    </RoleGuard>
  );
}
