"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { createUserWithEmailAndPassword, updateProfile } from "firebase/auth";
import { auth } from "@/lib/firebase/client";
import { useAuthSession } from "@/lib/auth/use-auth-session";

export default function RegisterPage() {
  const router = useRouter();
  const { firebaseUser, loading: sessionLoading } = useAuthSession();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const syncProfileBestEffort = async (token: string, nameValue: string | null) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    try {
      await fetch("/api/auth/sync", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ name: nameValue }),
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
      const credentials = await createUserWithEmailAndPassword(auth, email.trim(), password);

      if (name.trim()) {
        await updateProfile(credentials.user, { displayName: name.trim() });
      }

      const token = await credentials.user.getIdToken();
      await syncProfileBestEffort(token, name.trim() || null);
      router.replace("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha no cadastro.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="auth-card">
      <p className="pill">Novo acesso</p>
      <h1 className="auth-title mt-3">Criar conta</h1>
      <p className="mt-1 text-sm muted">
        O cadastro é livre, mas o acesso operacional exige aprovação do Admin.
      </p>
      <form className="mt-5 space-y-4" onSubmit={onSubmit}>
        <label className="field-label">
          Nome
          <input
            className="input-ui"
            onChange={(e) => setName(e.target.value)}
            type="text"
            value={name}
          />
        </label>
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
            minLength={6}
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
          {submitting ? "Criando..." : "Criar conta"}
        </button>
      </form>
      <p className="mt-5 text-sm muted">
        Já tem conta?{" "}
        <Link className="font-semibold underline" href="/login">
          Entrar
        </Link>
      </p>
    </section>
  );
}
