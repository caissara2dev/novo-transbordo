"use client";

import { useAuthSession } from "@/lib/auth/use-auth-session";

export function RoleGuard({
  allowed,
  children
}: {
  allowed: Array<"OPERATOR" | "SUPERVISOR" | "DISPLAY" | "ADMIN">;
  children: React.ReactNode;
}) {
  const { profile } = useAuthSession();

  if (!profile || !allowed.includes(profile.role)) {
    return <div className="notice error">Permissão insuficiente para esta área.</div>;
  }

  return <>{children}</>;
}
