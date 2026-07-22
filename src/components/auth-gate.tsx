"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuthSession } from "@/lib/auth/use-auth-session";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { firebaseUser, profile, loading, approvalContactPhone, profileError, refreshProfile } =
    useAuthSession();

  useEffect(() => {
    if (!loading && !firebaseUser && pathname !== "/login" && pathname !== "/register") {
      router.replace("/login");
    }
  }, [loading, firebaseUser, pathname, router]);

  if (loading) {
    return (
      <main className="auth-wrap">
        <section className="auth-card">
          <p className="pill">Sessão</p>
          <h1 className="auth-title mt-3">Carregando</h1>
          <p className="mt-1 text-sm muted">Validando credenciais e perfil operacional...</p>
        </section>
      </main>
    );
  }

  if (!firebaseUser) {
    return null;
  }

  if (!profile) {
    return (
      <main className="auth-wrap">
        <section className="auth-card">
          <p className="pill">Erro de sessão</p>
          <h1 className="auth-title mt-3">Falha ao carregar perfil</h1>
          <p className="mt-2 text-sm muted">
            Não foi possível validar seu acesso operacional. Tente sincronizar novamente.
          </p>
          {profileError ? <p className="notice error mt-3">Detalhe: {profileError}</p> : null}
          <div className="mt-5 flex gap-2">
            <button className="btn-primary" onClick={() => refreshProfile()} type="button">
              Tentar novamente
            </button>
            <button className="btn-ghost" onClick={() => router.replace("/login")} type="button">
              Voltar
            </button>
          </div>
        </section>
      </main>
    );
  }

  if (!profile.approved) {
    return (
      <main className="auth-wrap">
        <section className="auth-card">
          <p className="pill">Acesso pendente</p>
          <h1 className="auth-title mt-3">Aguardando aprovação</h1>
          <p className="mt-2 text-sm muted">
            Seu acesso ainda não foi aprovado.
            {approvalContactPhone ? ` Entre em contato com o responsável: ${approvalContactPhone}.` : ""}
          </p>
          <p className="mt-3 text-xs muted">Usuário: {profile.email}</p>
          <Link className="btn-primary mt-5 inline-flex" href="/login">
            Voltar
          </Link>
        </section>
      </main>
    );
  }

  return <>{children}</>;
}
