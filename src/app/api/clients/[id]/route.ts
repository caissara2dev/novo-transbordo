import { NextRequest } from "next/server";
import { ensureApproved, ensureRole, requireAuth } from "@/lib/server/auth";
import { fail, ok } from "@/lib/server/http";
import { toPlain } from "@/lib/server/serialize";
import { updateClient } from "@/lib/server/clients";

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const { profile, uid } = await requireAuth(req);

    ensureApproved(profile);
    ensureRole(profile, ["ADMIN"]);

    const body = (await req.json()) as { name?: string; active?: boolean };
    const updated = await updateClient(id, body, uid);

    return ok({ item: toPlain(updated) });
  } catch (error) {
    return fail(error);
  }
}
