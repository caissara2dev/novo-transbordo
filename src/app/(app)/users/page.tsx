"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { RoleGuard } from "@/components/role-guard";
import { apiFetch } from "@/lib/auth/api-fetch";
import { useAuthSession } from "@/lib/auth/use-auth-session";
import { isAbortError } from "@/lib/ui/latest-request";
import type { ClientApiItem, UserApiItem } from "@/types/api";
import type { UserRole } from "@/types/domain";

const roleLabels: Record<UserRole, string> = {OPERATOR: "Operador", SUPERVISOR: "Supervisor", DISPLAY: "Display TV", ADMIN: "Administrador", ANALYST: "Analista Line", CUSTOMER: "Cliente"};

function UserAccessCard({user, clients, ownAccount, disabled, onRole, onApproval}: {
  user: UserApiItem; clients: ClientApiItem[]; ownAccount: boolean; disabled: boolean;
  onRole: (user: UserApiItem, role: UserRole, clientId: string | null) => Promise<void>;
  onApproval: (user: UserApiItem) => Promise<void>;
}) {
  const [role, setRole] = useState(user.role);
  const [clientId, setClientId] = useState(user.clientId ?? "");
  const selectedClient = clients.find(c => c.id === clientId);
  const eligible = clients.filter(c => c.active && c.portalEnabled);
  const effectiveClient = role === "CUSTOMER" ? clientId : null;
  const dirty = role !== user.role || effectiveClient !== (user.clientId ?? null);
  const validClient = role !== "CUSTOMER" || !!selectedClient?.active && !!selectedClient.portalEnabled;
  function submit(event: FormEvent) {event.preventDefault();void onRole(user, role, effectiveClient);}
  return <article className="panel space-y-4" aria-label={`Acesso de ${user.email}`}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="font-medium break-all">{user.email}{ownAccount ? " · sua conta" : ""}</h2>
        <p className="text-sm muted">{user.name || "Nome não informado"}</p>
        <p className="text-sm mt-1">{user.approved ? "Aprovado" : "Aprovação pendente"}{!user.active ? " · Conta inativa" : ""}</p>
      </div>
      <button className={user.approved ? "btn-danger" : "btn-primary"} disabled={disabled || dirty || ownAccount}
        onClick={() => void onApproval(user)} type="button">
        {user.approved ? "Revogar aprovação" : "Aprovar acesso"}
      </button>
    </div>
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
      <label className="field-label flex flex-col gap-1 min-w-48">
        Perfil
        <select aria-label="Perfil" className="select-ui" disabled={disabled || ownAccount} value={role} onChange={e => setRole(e.target.value as UserRole)}>
          {Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      {role === "CUSTOMER" && <label className="field-label flex flex-col gap-1 min-w-48">
        Cliente da conta
        <select aria-label="Cliente da conta" className="select-ui" required disabled={disabled} value={clientId} onChange={e => setClientId(e.target.value)}>
          <option value="">Selecione o cliente</option>
          {clientId && !eligible.some(c => c.id === clientId) && <option value={clientId} disabled>{selectedClient?.name ?? "Cliente vinculado"} · portal indisponível</option>}
          {eligible.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}
        </select>
      </label>}
      <button className="btn-soft" disabled={disabled || ownAccount || !dirty || !validClient} type="submit">Salvar perfil</button>
    </form>
    <p className="text-xs muted">{ownAccount ? "Para alterar seu próprio acesso, peça a outro administrador." : dirty ? "Salve o perfil antes de aprovar esta conta. Salvar perfil não altera a aprovação." : "Perfil e aprovação são ações separadas. O cliente consulta apenas as cargas da empresa vinculada."}</p>
    {role === "CUSTOMER" && !validClient && <p className="text-sm muted">Selecione uma empresa ativa com o portal habilitado em <Link className="underline" href="/clients">Clientes</Link>.</p>}
  </article>;
}

export default function UsersPage() {
  const {firebaseUser} = useAuthSession();
  const [users, setUsers] = useState<UserApiItem[]>([]);
  const [clients, setClients] = useState<ClientApiItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async (signal?: AbortSignal) => {
    const [usersData, clientsData] = await Promise.all([
      apiFetch<{items: UserApiItem[]}>("/api/users", {signal}),
      apiFetch<{items: ClientApiItem[]}>("/api/clients?includeInactive=true", {signal})
    ]);
    return {users: usersData.items, clients: clientsData.items};
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).then(data => {
      if (!controller.signal.aborted) {setUsers(data.users);setClients(data.clients);}
    }).catch(reason => {
      if (!controller.signal.aborted && !isAbortError(reason)) setError(reason instanceof Error ? reason.message : "Falha ao carregar usuários.");
    }).finally(() => {if (!controller.signal.aborted) setLoading(false);});
    return () => controller.abort();
  }, [load]);
  async function refresh() {
    setError(null);setLoading(true);
    try {const data = await load();setUsers(data.users);setClients(data.clients);} catch(reason) {setError(reason instanceof Error ? reason.message : "Falha ao carregar usuários.");} finally {setLoading(false);}
  }
  async function mutate(user: UserApiItem, action: "role" | "approve", payload: object) {
    setPending(true);setError(null);setMessage(null);
    try {
      const result = await apiFetch<{item: UserApiItem}>(`/api/users/${user.id}/${action}`, {method: "POST", body: JSON.stringify({...payload, expectedVersion: user.accessVersion ?? 0})});
      setUsers(current => current.map(item => item.id === user.id ? result.item : item));
      setMessage(action === "role" ? "Perfil salvo. A aprovação da conta foi mantida." : "Aprovação atualizada.");
    } catch(reason) {setError(reason instanceof Error ? reason.message : "Falha ao atualizar acesso.");} finally {setPending(false);}
  }
  return <RoleGuard allowed={["ADMIN"]}><section className="space-y-5">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><p className="pill">Admin</p><h1 className="panel-title mt-2 text-3xl">Usuários</h1>
        <p className="text-sm muted">Defina o perfil, vincule contas de clientes e aprove o acesso separadamente.</p></div>
      <button className="btn-soft" disabled={pending || loading} type="button" onClick={() => void refresh()}>Atualizar lista</button>
    </header>
    <p className="notice">O acesso ao portal e o uso de amostra de cada empresa ficam em <Link href="/clients" className="underline font-medium">Clientes</Link>.</p>
    {error && <p className="notice error" role="alert">{error}</p>}
    {message && <p className="notice success" role="status">{message}</p>}
    {loading && <p className="text-sm muted" role="status">Carregando usuários…</p>}
    <div className="space-y-3">{users.map(user => <UserAccessCard key={`${user.id}:${user.accessVersion ?? 0}`} user={user} clients={clients}
      ownAccount={user.id === firebaseUser?.uid} disabled={pending || loading}
      onRole={(item, role, clientId) => mutate(item, "role", {role, clientId})}
      onApproval={item => mutate(item, "approve", {approved: !item.approved})}/> )}</div>
    {!loading && !users.length && <p className="text-sm muted">Nenhum usuário encontrado.</p>}
  </section></RoleGuard>;
}
