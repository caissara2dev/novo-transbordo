"use client";

import { useCallback, useEffect, useState } from "react";
import { RoleGuard } from "@/components/role-guard";
import { apiFetch } from "@/lib/auth/api-fetch";
import { isAbortError } from "@/lib/ui/latest-request";
import { UserApiItem } from "@/types/api";

export default function UsersPage() {
  const [users, setUsers] = useState<UserApiItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const fetchUsers = useCallback(async (signal?: AbortSignal) => {
    const data = await apiFetch<{ items: UserApiItem[] }>("/api/users", {
      signal
    });
    return data.items || [];
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    void fetchUsers(controller.signal)
      .then((nextUsers) => {
        if (!controller.signal.aborted) {
          setUsers(nextUsers);
        }
      })
      .catch((reason) => {
        if (!controller.signal.aborted && !isAbortError(reason)) {
          setError(reason instanceof Error ? reason.message : "Falha ao carregar usuários.");
        }
      });

    return () => controller.abort();
  }, [fetchUsers]);

  const setApproval = async (uid: string, approved: boolean) => {
    try {
      await apiFetch(`/api/users/${uid}/approve`, {
        method: "POST",
        body: JSON.stringify({ approved })
      });
      setUsers(await fetchUsers());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao atualizar aprovação.");
    }
  };

  const setRole = async (uid: string, role: string) => {
    try {
      await apiFetch(`/api/users/${uid}/role`, {
        method: "POST",
        body: JSON.stringify({ role })
      });
      setUsers(await fetchUsers());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao atualizar perfil.");
    }
  };

  return (
    <RoleGuard allowed={["ADMIN"]}>
      <section className="space-y-5">
        <header>
          <p className="pill">Admin</p>
          <h1 className="panel-title mt-2 text-3xl">Usuários</h1>
          <p className="text-sm muted">Aprovação manual e gestão de papéis.</p>
        </header>

        {error ? <div className="notice error">{error}</div> : null}

        <div className="space-y-2">
          {users.map((user) => (
            <article className="panel" key={user.id}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-medium">{user.email}</p>
                  <p className="text-xs muted">Nome: {user.name || "-"}</p>
                  <p className="text-xs muted">
                    Status: {user.approved ? "Aprovado" : "Pendente"}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    className={user.approved ? "btn-danger" : "btn-primary"}
                    onClick={() => setApproval(user.id, !user.approved)}
                    type="button"
                  >
                    {user.approved ? "Reprovar" : "Aprovar"}
                  </button>

                  <select
                    className="select-ui"
                    onChange={(e) => setRole(user.id, e.target.value)}
                    value={user.role}
                  >
                    <option value="OPERATOR">OPERATOR</option>
                    <option value="SUPERVISOR">SUPERVISOR</option>
                    <option value="DISPLAY">DISPLAY</option>
                    <option value="ADMIN">ADMIN</option>
                  </select>
                </div>
              </div>
            </article>
          ))}

          {!users.length ? <p className="text-sm muted">Nenhum usuário encontrado.</p> : null}
        </div>
      </section>
    </RoleGuard>
  );
}
