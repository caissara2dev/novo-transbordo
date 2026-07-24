"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuthSession } from "@/lib/auth/use-auth-session";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { profile, logout } = useAuthSession();
  const [menuOpen, setMenuOpen] = useState(false);

  const nav: Array<{
    href: "/dashboard" | "/events" | "/containers" | "/reports" | "/display" | "/clients" | "/users";
    label: string;
  }> = [
    { href: "/dashboard" as const, label: "Dashboard" },
    { href: "/events" as const, label: "Lançamentos" },
    { href: "/containers" as const, label: "Containers" },
    ...(profile?.role === "SUPERVISOR" || profile?.role === "ADMIN"
      ? [{ href: "/reports" as const, label: "Relatórios" }]
      : []),
    ...(profile?.role === "ADMIN" ? [{ href: "/display" as const, label: "Display TV" }] : []),
    ...(profile?.role === "ADMIN" ? [{ href: "/clients" as const, label: "Clientes" }] : []),
    ...(profile?.role === "ADMIN" ? [{ href: "/users" as const, label: "Usuários" }] : [])
  ];

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    document.documentElement.setAttribute("data-brand-theme", "b");
    window.localStorage.removeItem("brand-theme");
  }, []);

  return (
    <div className="app-stage">
      <header className="shell-top">
        <div className="shell-left">
          <button
            aria-label="Abrir menu"
            className="hamburger-btn"
            onClick={() => setMenuOpen((prev) => !prev)}
            type="button"
          >
            ☰
          </button>
          <div>
            <p className="brand-title">Controle Transbordo</p>
            <p className="brand-subtitle">Operação auditável de pátio | Santos-SP</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="pill">Perfil: {profile?.role || "-"}</span>
          <button className="btn-soft" onClick={() => logout()} type="button">
            Sair
          </button>
        </div>
      </header>
      {menuOpen ? <button className="nav-backdrop" onClick={() => setMenuOpen(false)} type="button" /> : null}
      <aside className={`nav-drawer ${menuOpen ? "open" : ""}`}>
        <p className="rail-caption">Navegação</p>
        <ul>
          {nav.map((item) => (
            <li key={item.href}>
              <Link className={`side-link ${pathname.startsWith(item.href) ? "active" : ""}`} href={item.href}>
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </aside>
      <div className="shell-body">
        <main className="main-canvas">{children}</main>
      </div>
    </div>
  );
}
