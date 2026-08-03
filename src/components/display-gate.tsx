"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { AuthGate } from "@/components/auth-gate";
import { useAuthSession } from "@/lib/auth/use-auth-session";

export function DisplayGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { profile, loading } = useAuthSession();
  const allowed = profile?.role === "DISPLAY" || profile?.role === "ADMIN";

  useEffect(() => {
    if (!loading && profile?.approved && !allowed) {
      router.replace("/dashboard");
    }
  }, [allowed, loading, profile, router]);

  return (
    <AuthGate>
      {allowed ? (
        children
      ) : (
        <main className="display-access-state">
          <p>Acesso ao display não autorizado.</p>
        </main>
      )}
    </AuthGate>
  );
}
