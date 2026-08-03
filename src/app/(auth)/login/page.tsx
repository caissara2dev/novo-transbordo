"use client";

import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import {
  sendEmailVerification,
  signInWithEmailAndPassword,
  signOut
} from "firebase/auth";
import {
  authenticatedFetch,
  readApiResponse
} from "@/lib/auth/api-fetch";
import { auth } from "@/lib/firebase/client";
import { useAuthSession } from "@/lib/auth/use-auth-session";

async function syncProfileBestEffort(): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await authenticatedFetch(
      "/api/auth/sync",
      {
        method: "POST",
        signal: controller.signal
      }
    );
    await readApiResponse(response);
  } catch {
    // Sync is retried by session loading flow.
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLoginProfileRole(): Promise<string | undefined> {
  const response = await authenticatedFetch("/api/me");
  const payload = await readApiResponse<{
    profile?: { role?: string };
  }>(response);

  return payload?.profile?.role;
}

export default function LoginPage() {
  const router = useRouter();
  const { firebaseUser, profile, loading: sessionLoading } = useAuthSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!sessionLoading && firebaseUser?.emailVerified && profile) {
      router.replace((profile.role === "DISPLAY" ? "/display" : "/dashboard") as Route);
    }
  }, [sessionLoading, firebaseUser, profile, router]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setSubmitting(true);

    try {
      const credentials = await signInWithEmailAndPassword(auth, email.trim(), password);

      if (!credentials.user.emailVerified) {
        try {
          await sendEmailVerification(credentials.user);
        } finally {
          await signOut(auth);
        }

        setNotice(
          "Seu email ainda não foi verificado. Enviamos um novo link de verificação."
        );
        return;
      }

      await syncProfileBestEffort();
      const role = await fetchLoginProfileRole();
      router.replace((role === "DISPLAY" ? "/display" : "/dashboard") as Route);
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
        {notice ? (
          <p className="notice" role="status">
            {notice}
          </p>
        ) : null}
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
        Não tem conta?{" "}
        <Link className="font-semibold underline" href="/register">
          Criar cadastro
        </Link>
      </p>
    </section>
  );
}
