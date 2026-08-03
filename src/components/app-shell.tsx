"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAuthSession } from "@/lib/auth/use-auth-session";

const BRAND_THEMES = new Set(["a", "b", "c"]);

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { profile, logout } = useAuthSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const wasMenuOpen = useRef(false);
  const previousPathname = useRef(pathname);

  const nav: Array<{
    href: "/dashboard" | "/events" | "/containers" | "/reports" | "/display" | "/clients" | "/users" | "/settings";
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
    ...(profile?.role === "ADMIN" ? [{ href: "/users" as const, label: "Usuários" }] : []),
    ...(profile?.role === "ADMIN" ? [{ href: "/settings" as const, label: "Configurações" }] : [])
  ];

  useEffect(() => {
    if (previousPathname.current === pathname) {
      return;
    }

    previousPathname.current = pathname;
    const closeMenu = window.requestAnimationFrame(() => {
      setMenuOpen(false);
    });

    return () => window.cancelAnimationFrame(closeMenu);
  }, [pathname]);

  useEffect(() => {
    const savedTheme = window.localStorage.getItem("brand-theme");

    if (savedTheme && BRAND_THEMES.has(savedTheme)) {
      document.documentElement.setAttribute("data-brand-theme", savedTheme);
    }
  }, []);

  useEffect(() => {
    if (!menuOpen) {
      if (wasMenuOpen.current) {
        window.requestAnimationFrame(() => menuButtonRef.current?.focus());
      }
      wasMenuOpen.current = false;
      return;
    }

    wasMenuOpen.current = true;
    const drawer = drawerRef.current;
    const focusableSelector =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusFirst = window.requestAnimationFrame(() => {
      drawer?.querySelector<HTMLElement>(focusableSelector)?.focus();
    });

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuOpen(false);
        return;
      }

      if (event.key !== "Tab" || !drawer) {
        return;
      }

      const focusable = Array.from(
        drawer.querySelectorAll<HTMLElement>(focusableSelector)
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (!first || !last) {
        event.preventDefault();
        return;
      }

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      window.cancelAnimationFrame(focusFirst);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  return (
    <div className="app-stage">
      <header className="shell-top">
        <div className="shell-left">
          <button
            aria-controls="app-navigation"
            aria-expanded={menuOpen}
            aria-haspopup="dialog"
            aria-label={menuOpen ? "Fechar menu" : "Abrir menu"}
            className="hamburger-btn"
            onClick={() => setMenuOpen((prev) => !prev)}
            ref={menuButtonRef}
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
      {menuOpen ? (
        <button
          aria-label="Fechar menu"
          className="nav-backdrop"
          onClick={() => setMenuOpen(false)}
          tabIndex={-1}
          type="button"
        />
      ) : null}
      <aside
        aria-hidden={!menuOpen}
        aria-label="Navegação principal"
        aria-modal={menuOpen ? true : undefined}
        className={`nav-drawer ${menuOpen ? "open" : ""}`}
        id="app-navigation"
        inert={!menuOpen}
        ref={drawerRef}
        role="dialog"
      >
        <div className="flex items-center justify-between gap-2">
          <p className="rail-caption">Navegação</p>
          <button
            aria-label="Fechar menu"
            className="btn-soft"
            onClick={() => setMenuOpen(false)}
            type="button"
          >
            Fechar
          </button>
        </div>
        <ul>
          {nav.map((item) => (
            <li key={item.href}>
              <Link
                className={`side-link ${pathname.startsWith(item.href) ? "active" : ""}`}
                href={{ pathname: item.href }}
                onClick={() => setMenuOpen(false)}
              >
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
