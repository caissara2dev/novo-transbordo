"use client";

import { onAuthStateChanged, signOut, User } from "firebase/auth";
import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { auth } from "@/lib/firebase/client";
import { UserDoc } from "@/types/domain";

type SessionState = {
  firebaseUser: User | null;
  profile: UserDoc | null;
  approvalContactPhone: string | null;
  profileError: string | null;
  loading: boolean;
  refreshProfile: () => Promise<void>;
  logout: () => Promise<void>;
};

const SessionContext = createContext<SessionState | undefined>(undefined);

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs = 8000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchMe(user: User): Promise<{
  profile: UserDoc;
  approvalContactPhone: string | null;
}> {
  const token = await user.getIdToken();
  const res = await fetchWithTimeout("/api/me", {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (res.status === 404) {
    const syncRes = await fetchWithTimeout("/api/auth/sync", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (!syncRes.ok) {
      throw new Error("Não foi possível sincronizar o perfil do usuário.");
    }

    const retry = await fetchWithTimeout("/api/me", {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (!retry.ok) {
      throw new Error("Não foi possível carregar o perfil.");
    }

    return retry.json();
  }

  if (!res.ok) {
    throw new Error("Falha ao carregar perfil.");
  }

  return res.json();
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserDoc | null>(null);
  const [approvalContactPhone, setApprovalContactPhone] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshProfile = async () => {
    if (!auth.currentUser) {
      setProfile(null);
      setProfileError(null);
      return;
    }

    try {
      const payload = await fetchMe(auth.currentUser);
      setProfile(payload.profile);
      setApprovalContactPhone(payload.approvalContactPhone);
      setProfileError(null);
    } catch (error) {
      setProfile(null);
      setProfileError(error instanceof Error ? error.message : "Falha ao carregar perfil.");
    }
  };

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      setFirebaseUser(user);

      if (!user) {
        setProfile(null);
        setApprovalContactPhone(null);
        setProfileError(null);
        setLoading(false);
        return;
      }

      try {
        const payload = await fetchMe(user);
        setProfile(payload.profile);
        setApprovalContactPhone(payload.approvalContactPhone);
        setProfileError(null);
      } catch (error) {
        setProfile(null);
        setProfileError(error instanceof Error ? error.message : "Falha ao carregar perfil.");
      } finally {
        setLoading(false);
      }
    });

    return () => unsub();
  }, []);

  const value = useMemo<SessionState>(
    () => ({
      firebaseUser,
      profile,
      approvalContactPhone,
      profileError,
      loading,
      refreshProfile,
      logout: () => signOut(auth)
    }),
    [firebaseUser, profile, approvalContactPhone, profileError, loading]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useAuthSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error("useAuthSession must be used within SessionProvider");
  }

  return ctx;
}
