"use client";

import { auth } from "@/lib/firebase/client";

export async function apiFetch<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const user = auth.currentUser;

  if (!user) {
    throw new Error("Usuario nao autenticado.");
  }

  const token = await user.getIdToken();

  const response = await fetch(input, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
      Authorization: `Bearer ${token}`
    }
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(payload?.error || "Erro de requisicao.");
  }

  return payload as T;
}
