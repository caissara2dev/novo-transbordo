"use client";

import { onAuthStateChanged, signOut, User } from "firebase/auth";
import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { authenticatedFetch, readApiResponse } from "@/lib/auth/api-fetch";
import { auth } from "@/lib/firebase/client";
import { createLatestRequestCoordinator } from "@/lib/ui/latest-request";
import { UserDoc } from "@/types/domain";

type SessionState = {
  firebaseUser: User | null;
  profile: UserDoc | null;
  containerTransfersEnabled: boolean;
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
  const upstreamSignal = init.signal;
  const abortFromUpstream = () => controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  if (upstreamSignal?.aborted) {
    controller.abort();
  } else {
    upstreamSignal?.addEventListener("abort", abortFromUpstream, {
      once: true
    });
  }

  try {
    return await authenticatedFetch(input, {
      ...init,
      signal: controller.signal
    });
  } catch (error) {
    if (timedOut && !upstreamSignal?.aborted) {
      throw new Error("A solicitação demorou demais. Tente novamente.");
    }

    throw error;
  } finally {
    clearTimeout(timer);
    upstreamSignal?.removeEventListener("abort", abortFromUpstream);
  }
}

export async function fetchSessionProfile(signal: AbortSignal): Promise<{
  profile: UserDoc;
  containerTransfersEnabled?: boolean;
  approvalContactPhone: string | null;
}> {
  const res = await fetchWithTimeout("/api/me", {
    signal
  });

  if (res.status === 404) {
    const syncRes = await fetchWithTimeout("/api/auth/sync", {
      method: "POST",
      signal
    });

    await readApiResponse(syncRes);

    const retry = await fetchWithTimeout("/api/me", {
      signal
    });

    return readApiResponse(retry);
  }

  return readApiResponse(res);
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [containerTransfersEnabled, setContainerTransfersEnabled] =
    useState(false);
  const [profile, setProfile] = useState<UserDoc | null>(null);
  const [approvalContactPhone, setApprovalContactPhone] = useState<
    string | null
  >(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const profileRequests = useRef(createLatestRequestCoordinator());

  const refreshProfile = useCallback(async () => {
    const user = auth.currentUser;

    if (!user) {
      profileRequests.current.cancel();
      setProfile(null);
      setContainerTransfersEnabled(false);
      setApprovalContactPhone(null);
      setProfileError(null);
      setLoading(false);
      return;
    }

    const request = profileRequests.current.begin();
    setLoading(true);
    setProfileError(null);

    try {
      const payload = await fetchSessionProfile(request.signal);
      if (!request.isCurrent() || auth.currentUser?.uid !== user.uid) {
        return;
      }

      setProfile(payload.profile);
      setContainerTransfersEnabled(payload.containerTransfersEnabled === true);
      setApprovalContactPhone(payload.approvalContactPhone);
      setProfileError(null);
    } catch (error) {
      if (!request.isCurrent()) {
        return;
      }

      setProfile(null);
      setContainerTransfersEnabled(false);
      setApprovalContactPhone(null);
      setProfileError(
        error instanceof Error ? error.message : "Falha ao carregar perfil."
      );
    } finally {
      if (request.isCurrent()) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const requests = profileRequests.current;
    const unsub = onAuthStateChanged(auth, async (user) => {
      setFirebaseUser(user);
      setProfile(null);
      setContainerTransfersEnabled(false);
      setApprovalContactPhone(null);
      setProfileError(null);

      if (!user) {
        profileRequests.current.cancel();
        setLoading(false);
        return;
      }

      const request = profileRequests.current.begin();
      setLoading(true);

      try {
        const payload = await fetchSessionProfile(request.signal);
        if (!request.isCurrent() || auth.currentUser?.uid !== user.uid) {
          return;
        }

        setProfile(payload.profile);
        setContainerTransfersEnabled(
          payload.containerTransfersEnabled === true
        );
        setApprovalContactPhone(payload.approvalContactPhone);
        setProfileError(null);
      } catch (error) {
        if (!request.isCurrent()) {
          return;
        }

        setProfile(null);
        setContainerTransfersEnabled(false);
        setApprovalContactPhone(null);
        setProfileError(
          error instanceof Error ? error.message : "Falha ao carregar perfil."
        );
      } finally {
        if (request.isCurrent()) {
          setLoading(false);
        }
      }
    });

    return () => {
      requests.cancel();
      unsub();
    };
  }, []);

  const value = useMemo<SessionState>(
    () => ({
      firebaseUser,
      profile,
      containerTransfersEnabled,
      approvalContactPhone,
      profileError,
      loading,
      refreshProfile,
      logout: () => signOut(auth)
    }),
    [
      firebaseUser,
      profile,
      containerTransfersEnabled,
      approvalContactPhone,
      profileError,
      loading,
      refreshProfile
    ]
  );

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useAuthSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error("useAuthSession must be used within SessionProvider");
  }

  return ctx;
}
