import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/server/auth";
import { fail, ok } from "@/lib/server/http";
import { ensureUserProfile } from "@/lib/server/users";

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireAuth(req).catch(() => null);

    if (!ctx) {
      const authHeader = req.headers.get("authorization") || "";
      if (!authHeader.startsWith("Bearer ")) {
        return ok({ ok: false }, 401);
      }

      const { adminAuth } = await import("@/lib/firebase/admin");
      const decoded = await adminAuth.verifyIdToken(authHeader.slice(7));
      const body = (await req.json().catch(() => ({}))) as { name?: string | null };

      await ensureUserProfile({
        uid: decoded.uid,
        email: decoded.email || "",
        name: body?.name?.trim() || decoded.name || null
      });

      return ok({ ok: true });
    }

    const body = (await req.json().catch(() => ({}))) as { name?: string | null };

    await ensureUserProfile({
      uid: ctx.uid,
      email: ctx.email,
      name: body?.name?.trim() || ctx.token.name || null
    });

    return ok({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
