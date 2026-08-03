import { NextRequest } from "next/server";
import { z } from "zod";
import { ensureApproved, ensureRole, requireAuth } from "@/lib/server/auth";
import { fail, ok, parseJsonBody } from "@/lib/server/http";
import { toPlain } from "@/lib/server/serialize";
import { updateClient } from "@/lib/server/clients";

const updateClientBodySchema = z
  .object({
    name: z.string().optional(),
    active: z.boolean().optional()
  })
  .strict();

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const { profile, uid } = await requireAuth(req);

    ensureApproved(profile);
    ensureRole(profile, ["ADMIN"]);

    const body = await parseJsonBody(req, updateClientBodySchema);
    const updated = await updateClient(id, body, uid);

    return ok({ item: toPlain(updated) });
  } catch (error) {
    return fail(error);
  }
}
