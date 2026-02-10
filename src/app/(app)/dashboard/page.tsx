"use client";

import Link from "next/link";
import { useAuthSession } from "@/lib/auth/use-auth-session";

export default function DashboardPage() {
  const { profile } = useAuthSession();
  const shortcuts: Array<{ href: "/events" | "/reports" | "/clients" | "/users"; title: string; desc: string }> = [
    {
      href: "/events" as const,
      title: "Lançamentos",
      desc: "Registrar, editar e consultar histórico operacional."
    },
    ...(profile?.role === "SUPERVISOR" || profile?.role === "ADMIN"
      ? [
          {
            href: "/reports" as const,
            title: "Relatórios",
            desc: "Indicadores, gráficos e exportações operacionais."
          }
        ]
      : []),
    ...(profile?.role === "ADMIN"
      ? [
          {
            href: "/clients" as const,
            title: "Clientes",
            desc: "Cadastro, ativacao e governanca da base de clientes."
          },
          {
            href: "/users" as const,
            title: "Usuários",
            desc: "Aprovações manuais e ajuste de papéis de acesso."
          }
        ]
      : [])
  ];

  return (
    <section className="space-y-5">
      <div>
        <p className="pill">Painel de controle</p>
        <h1 className="panel-title mt-2 text-3xl">Visão geral do turno</h1>
        <p className="mt-1 text-sm muted">
          Bem-vindo(a), {profile?.name || profile?.email}. Use os atalhos para operar o turno.
        </p>
      </div>

      <div className="metric-grid">
        <article className="metric-card">
          <p className="metric-label">Perfil ativo</p>
          <p className="metric-value">{profile?.role || "-"}</p>
        </article>
        <article className="metric-card">
          <p className="metric-label">Aprovação</p>
          <p className="metric-value">{profile?.approved ? "LIBERADO" : "PENDENTE"}</p>
        </article>
        <article className="metric-card">
          <p className="metric-label">Base</p>
          <p className="metric-value">SANTOS</p>
        </article>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {shortcuts.map((item) => (
          <Link className="panel transition hover:-translate-y-0.5" href={item.href} key={item.href}>
            <p className="panel-title text-2xl">{item.title}</p>
            <p className="mt-1 text-sm muted">{item.desc}</p>
          </Link>
        ))}
      </div>
    </section>
  );
}
