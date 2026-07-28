"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { registerAccount } from "@/lib/auth/register-account";
import { auth } from "@/lib/firebase/client";
import { useAuthSession } from "@/lib/auth/use-auth-session";

export default function RegisterPage() {
  const router = useRouter();
  const { firebaseUser, loading: sessionLoading } = useAuthSession();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [verificationSentTo, setVerificationSentTo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!sessionLoading && firebaseUser?.emailVerified) {
      router.replace("/dashboard");
    }
  }, [sessionLoading, firebaseUser, router]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const verificationEmail = await registerAccount({
        auth,
        email,
        name,
        password
      });
      setVerificationSentTo(verificationEmail);
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
        O acesso exige a verificação do email e a aprovação do Admin.
      </p>
      {verificationSentTo ? (
        <div className="notice mt-5" role="status">
          Enviamos um link de verificação para <strong>{verificationSentTo}</strong>.
          Verifique o email antes de entrar.
        </div>
      ) : (
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
      )}
      <p className="mt-5 text-sm muted">
        {verificationSentTo ? "Já verificou o email? " : "Já tem conta? "}
        <Link className="font-semibold underline" href="/login">
          Entrar
        </Link>
      </p>
    </section>
  );
}
