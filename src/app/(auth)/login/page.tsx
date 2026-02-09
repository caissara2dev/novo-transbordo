"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { signInWithEmailAndPassword } from "firebase/auth";
import { auth } from "@/lib/firebase/client";
import { useAuthSession } from "@/lib/auth/use-auth-session";

export default function LoginPage() {
  const router = useRouter();
  const { firebaseUser, loading: sessionLoading } = useAuthSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const syncProfileBestEffort = async (token: string) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    try {
      await fetch("/api/auth/sync", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`
        },
        signal: controller.signal
      });
    } catch {
      // Sync is retried by session loading flow.
    } finally {
      clearTimeout(timer);
    }
  };

  useEffect(() => {
    if (!sessionLoading && firebaseUser) {
      router.replace("/dashboard");
    }
  }, [sessionLoading, firebaseUser, router]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const credentials = await signInWithEmailAndPassword(auth, email.trim(), password);
      const token = await credentials.user.getIdToken();
      await syncProfileBestEffort(token);
      router.replace("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao autenticar.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="auth-card">
      <p className="pill">Acesso Operacional</p>
      <h1 className="auth-title mt-3">Entrar</h1>
      <p className="mt-1 text-sm muted">Acesse com email e senha.</p>
      <form className="mt-5 space-y-4" onSubmit={onSubmit}>
        <label className="field-label">
          Email
          <input
            className="input-ui"
            onChange={(e) => setEmail(e.target.value)}
            required
            type="email"
            value={email}
          />
        </label>
        <label className="field-label">
          Senha
          <input
            className="input-ui"
            onChange={(e) => setPassword(e.target.value)}
            required
            type="password"
            value={password}
          />
        </label>
        {error ? <p className="notice error">{error}</p> : null}
        <button
          className="btn-primary w-full"
          disabled={submitting}
          type="submit"
        >
          {submitting ? "Entrando..." : "Entrar"}
        </button>
      </form>
      <p className="mt-5 text-sm muted">
        Nao tem conta?{" "}
        <Link className="font-semibold underline" href="/register">
          Criar cadastro
        </Link>
      </p>
    </section>
  );
}
