import { Timestamp } from "firebase-admin/firestore";
import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { canEdit } from "@/lib/domain/validation";
import { HttpError } from "@/lib/domain/errors";
import { ensureApproved, ensureRole, requireAuth } from "@/lib/server/auth";
import { softDeleteEvent, updateEvent } from "@/lib/server/events";
import { fail, ok } from "@/lib/server/http";
import { toPlain } from "@/lib/server/serialize";

function toMillis(value: unknown): number {
  if (value instanceof Timestamp) {
    return value.toMillis();
  }

  if (value && typeof value === "object" && "_seconds" in (value as Record<string, unknown>)) {
    const sec = Number((value as { _seconds: unknown })._seconds);
    const ns = Number((value as { _nanoseconds?: unknown })._nanoseconds || 0);
    return sec * 1000 + Math.floor(ns / 1000000);
  }

  if (typeof value === "string") {
    return new Date(value).getTime();
  }

  return 0;
}

async function assertEditableWindow(eventId: string, role: string): Promise<void> {
  if (role === "ADMIN") {
    return;
  }

  const snap = await adminDb.collection("events").doc(eventId).get();

  if (!snap.exists) {
    throw new HttpError(404, "Lançamento não encontrado.");
  }

  const createdAtMs = toMillis(snap.data()?.createdAt);
  const allowed = canEdit(role, createdAtMs, Date.now());

  if (!allowed) {
    throw new HttpError(403, "Supervisor só pode alterar/excluir nas primeiras 24h.");
  }
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const { profile, uid, email } = await requireAuth(req);
    ensureApproved(profile);
    ensureRole(profile, ["SUPERVISOR", "ADMIN"]);
    await assertEditableWindow(id, profile.role);

    const body = await req.json();
    const updated = await updateEvent(id, body, {
      uid,
      email,
      role: profile.role
    });

    return ok({ item: toPlain(updated) });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const { profile, uid, email } = await requireAuth(req);
    ensureApproved(profile);
    ensureRole(profile, ["SUPERVISOR", "ADMIN"]);
    await assertEditableWindow(id, profile.role);

    const body = (await req.json().catch(() => ({}))) as { reason?: string };
    const result = await softDeleteEvent(id, body.reason || "", {
      uid,
      email
    });

    return ok(result);
  } catch (error) {
    return fail(error);
  }
}
