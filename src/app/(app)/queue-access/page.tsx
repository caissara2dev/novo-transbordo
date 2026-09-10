"use client";
import { useEffect, useState } from "react";
import { RoleGuard } from "@/components/role-guard";
import { apiFetch } from "@/lib/auth/api-fetch";
import type { QueueClient } from "@/lib/domain/queue";
type AccessData = {
  clients: QueueClient[];
  users: Array<{
    id: string;
    email: string;
    role: string;
    clientId: string | null;
    approved: boolean;
  }>;
};
export default function Page() {
  const [data, setData] = useState<AccessData>({ clients: [], users: [] });
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [user, setUser] = useState("");
  const [role, setRole] = useState("CUSTOMER");
  const [client, setClient] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void apiFetch<AccessData>("/api/queue-access", {
      signal: controller.signal,
    })
      .then(setData)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, []);
  async function save(command: unknown) {
    setPending(true);
    setError("");
    try {
      await apiFetch("/api/queue-access", {
        method: "POST",
        body: JSON.stringify(command),
      });
      setData(await apiFetch<AccessData>("/api/queue-access"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao salvar.");
    } finally {
      setPending(false);
    }
  }
  return (
    <RoleGuard allowed={["ADMIN"]}>
      <section className="space-y-5">
        <header>
          <h1 className="panel-title">Acessos da fila</h1>
          <p className="muted">
            Habilite clientes participantes e vincule cada conta à sua empresa.
          </p>
        </header>
        {error && (
          <p role="alert" className="notice error">
            {error}
          </p>
        )}
        <section className="panel space-y-3">
          <h2>Clientes participantes</h2>
          {data.clients.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-4">
              <strong>{c.name}</strong>
              <label>
                <input
                  type="checkbox"
                  disabled={pending}
                  checked={c.portalEnabled}
                  onChange={(e) =>
                    void save({
                      kind: "CLIENT",
                      clientId: c.id,
                      portalEnabled: e.target.checked,
                      usesSample: c.usesSample,
                    })
                  }
                />{" "}
                Acesso ao portal
              </label>
              <label>
                <input
                  type="checkbox"
                  disabled={pending}
                  checked={c.usesSample}
                  onChange={(e) =>
                    void save({
                      kind: "CLIENT",
                      clientId: c.id,
                      portalEnabled: c.portalEnabled,
                      usesSample: e.target.checked,
                    })
                  }
                />{" "}
                Usa amostra
              </label>
            </div>
          ))}
        </section>
        <form
          className="panel space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save({
              kind: "USER",
              uid: user,
              role,
              clientId: role === "CUSTOMER" ? client : null,
            });
          }}
        >
          <h2>Conceder acesso a uma conta cadastrada</h2>
          <label className="field-label">
            Conta
            <select
              required
              value={user}
              onChange={(e) => setUser(e.target.value)}
            >
              <option value="">Selecione</option>
              {data.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.email} · {u.role}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            Perfil
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="CUSTOMER">Cliente</option>
              <option value="ANALYST">Analista Line</option>
            </select>
          </label>
          {role === "CUSTOMER" && (
            <label className="field-label">
              Empresa
              <select
                required
                value={client}
                onChange={(e) => setClient(e.target.value)}
              >
                <option value="">Selecione</option>
                {data.clients
                  .filter((c) => c.portalEnabled)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <button className="btn-primary" type="submit" disabled={pending}>
            Conceder acesso
          </button>
          <p className="text-sm muted">
            A verificação de e-mail continua obrigatória. Para revogar uma
            conta, remova a aprovação em Usuários.
          </p>
        </form>
      </section>
    </RoleGuard>
  );
}
