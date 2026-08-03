import { NextRequest } from "next/server";
import { ensureApproved, requireAuth } from "@/lib/server/auth";
import { gapPreviewBodySchema } from "@/lib/server/event-request-schemas";
import { fail, ok, parseJsonBody } from "@/lib/server/http";
import { previewEventGap } from "@/lib/server/gaps";

export async function POST(req: NextRequest) {
  try {
    const { profile } = await requireAuth(req);
    ensureApproved(profile);
    const body = await parseJsonBody(req, gapPreviewBodySchema);
    const result = await previewEventGap(body);
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}
