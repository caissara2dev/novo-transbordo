import { NextRequest } from "next/server";
import { createEvent, listEvents } from "@/lib/server/events";
import { ensureApproved, requireAuth } from "@/lib/server/auth";
import { eventCreateBodySchema } from "@/lib/server/event-request-schemas";
import { fail, ok, parseJsonBody } from "@/lib/server/http";
import { parseEventFilters } from "@/lib/server/filters";
import { parsePagination } from "@/lib/server/pagination";
import { toPlain } from "@/lib/server/serialize";

export async function GET(req: NextRequest) {
  try {
    const { profile, uid } = await requireAuth(req);
    ensureApproved(profile);

    const filters = parseEventFilters(req.nextUrl.searchParams);
    const pagination = parsePagination(req.nextUrl.searchParams);
    const page = await listEvents({
      role: profile.role,
      uid,
      filters,
      pagination
    });

    return ok(toPlain(page));
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { profile, uid, email } = await requireAuth(req);
    ensureApproved(profile);

    const body = await parseJsonBody(req, eventCreateBodySchema);
    const result = await createEvent(body, {
      uid,
      email,
      role: profile.role
    });

    return ok({ item: toPlain(result) }, 201);
  } catch (error) {
    return fail(error);
  }
}
