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
