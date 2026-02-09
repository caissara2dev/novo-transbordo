"use client";

import Link from "next/link";
import { useAuthSession } from "@/lib/auth/use-auth-session";

export default function DashboardPage() {
  const { profile } = useAuthSession();
  const shortcuts = [
    {
      href: "/events",
      title: "Lancamentos",
      desc: "Registrar, editar e consultar historico operacional."
    },
    ...(profile?.role === "ADMIN"
      ? [
          {
            href: "/clients",
            title: "Clientes",
            desc: "Cadastro, ativacao e governanca da base de clientes."
          },
          {
            href: "/users",
            title: "Usuarios",
            desc: "Aprovacoes manuais e ajuste de papeis de acesso."
          }
        ]
      : [])
  ];

  return (
    <section className="space-y-5">
      <div>
        <p className="pill">Painel de controle</p>
        <h1 className="panel-title mt-2 text-3xl">Visao geral do turno</h1>
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
          <p className="metric-label">Aprovacao</p>
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
