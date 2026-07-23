import { NextRequest } from "next/server";
import { ensureApproved, requireAuth } from "@/lib/server/auth";
import { lookupContainer } from "@/lib/server/container-states";
import { fail, ok } from "@/lib/server/http";
import { toPlain } from "@/lib/server/serialize";

export async function GET(req: NextRequest) {
  try {
    const { profile } = await requireAuth(req);
    ensureApproved(profile);

    const container = req.nextUrl.searchParams.get("container") || "";
    const result = await lookupContainer(container);
    return ok(toPlain(result));
  } catch (error) {
    return fail(error);
  }
}
