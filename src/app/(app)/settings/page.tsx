"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { RoleGuard } from "@/components/role-guard";
import { apiFetch } from "@/lib/auth/api-fetch";
import { useAuthSession } from "@/lib/auth/use-auth-session";
import { isAbortError } from "@/lib/ui/latest-request";

type OperationsSettings = {
  idleToleranceMinutes: number;
};

export default function SettingsPage() {
  const { profile } = useAuthSession();
  const [minutes, setMinutes] = useState(10);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(
    (signal?: AbortSignal) =>
      apiFetch<OperationsSettings>("/api/settings/operations", { signal }),
    []
  );

  useEffect(() => {
    if (profile?.role !== "ADMIN") return;

    const controller = new AbortController();
    const scheduledLoad = window.setTimeout(() => {
      setLoading(true);
      void load(controller.signal)
        .then((settings) => {
          if (!controller.signal.aborted) {
            setMinutes(settings.idleToleranceMinutes);
          }
        })
        .catch((reason) => {
          if (!controller.signal.aborted && !isAbortError(reason)) {
            setError(reason instanceof Error ? reason.message : "Falha ao carregar.");
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setLoading(false);
          }
        });
    }, 0);

    return () => {
      window.clearTimeout(scheduledLoad);
      controller.abort();
    };
  }, [load, profile?.role]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const settings = await apiFetch<OperationsSettings>("/api/settings/operations", {
        method: "PATCH",
        body: JSON.stringify({ idleToleranceMinutes: minutes })
      });
      setMinutes(settings.idleToleranceMinutes);
      setMessage("Limite atualizado. Os próximos previews já usarão o novo valor.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Falha ao salvar.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <RoleGuard allowed={["ADMIN"]}>
      <section className="mx-auto max-w-3xl space-y-5">
        <header className="settings-hero">
          <p className="settings-eyebrow">Regras operacionais</p>
          <h1>Configurações</h1>
          <p className="settings-description">
            Este valor é global para as três bombas. Todo intervalo continuará sendo registrado;
            o limite controla apenas quando uma causa passa a ser obrigatória.
          </p>
        </header>

        {error ? <div className="notice error">{error}</div> : null}
        {message ? <div className="notice success">{message}</div> : null}

        <form className="panel space-y-5" onSubmit={save}>
          <div className="grid gap-5 md:grid-cols-[1fr_180px] md:items-end">
            <div>
              <h2 className="panel-title">Ociosidade automática</h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Intervalos até o limite recebem a categoria interna “Intervalo operacional”.
                Acima dele, o operador deve justificar cada trecho descoberto.
              </p>
            </div>
            <label className="field-label">
              Limite sem justificativa
              <div className="relative">
                <input
                  className="input-ui pr-14 text-lg font-extrabold"
                  disabled={loading || saving}
                  max={60}
                  min={0}
                  onChange={(event) => setMinutes(Number(event.target.value))}
                  required
                  type="number"
                  value={minutes}
                />
                <span className="pointer-events-none absolute right-3 top-[1.05rem] text-xs font-bold text-slate-500">
                  min
                </span>
              </div>
            </label>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-slate-200 pt-4">
            <p className="text-xs text-slate-500">Faixa permitida: 0 a 60 minutos.</p>
            <button className="btn-primary" disabled={loading || saving} type="submit">
              {saving ? "Salvando…" : "Salvar configuração"}
            </button>
          </div>
        </form>
      </section>
    </RoleGuard>
  );
}
