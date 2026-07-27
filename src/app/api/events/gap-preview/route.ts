import { NextRequest } from "next/server";
import { ensureApproved, requireAuth } from "@/lib/server/auth";
import { fail, ok } from "@/lib/server/http";
import { previewEventGap } from "@/lib/server/gaps";

export async function POST(req: NextRequest) {
  try {
    const { profile } = await requireAuth(req);
    ensureApproved(profile);
    const result = await previewEventGap(await req.json());
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}
