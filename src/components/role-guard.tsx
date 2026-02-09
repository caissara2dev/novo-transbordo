"use client";

import { useAuthSession } from "@/lib/auth/use-auth-session";

export function RoleGuard({
  allowed,
  children
}: {
  allowed: Array<"OPERATOR" | "SUPERVISOR" | "ADMIN">;
  children: React.ReactNode;
}) {
  const { profile } = useAuthSession();

  if (!profile || !allowed.includes(profile.role)) {
    return <div className="notice error">Permissao insuficiente para esta area.</div>;
  }

  return <>{children}</>;
}
