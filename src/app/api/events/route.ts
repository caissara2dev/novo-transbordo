import { Timestamp } from "firebase-admin/firestore";
import { NextRequest } from "next/server";
import { createEvent, listEvents } from "@/lib/server/events";
import { ensureApproved, requireAuth } from "@/lib/server/auth";
import { fail, ok } from "@/lib/server/http";
import { parseEventFilters } from "@/lib/server/filters";
import { toPlain } from "@/lib/server/serialize";

export async function GET(req: NextRequest) {
  try {
    const { profile, uid } = await requireAuth(req);
    ensureApproved(profile);

    const filters = parseEventFilters(req.nextUrl.searchParams);
    const rows = await listEvents({
      role: profile.role,
      uid,
      filters
    });

    return ok({ items: toPlain(rows) });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { profile, uid, email } = await requireAuth(req);
    ensureApproved(profile);

    const body = await req.json();
    const result = await createEvent(body, {
      uid,
      email
    });

    return ok({ item: toPlain(result) }, 201);
  } catch (error) {
    return fail(error);
  }
}

export function createdAtToMs(value: unknown): number {
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
