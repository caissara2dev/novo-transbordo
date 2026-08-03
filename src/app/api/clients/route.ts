import { NextRequest } from "next/server";
import { z } from "zod";
import { ensureApproved, ensureRole, requireAuth } from "@/lib/server/auth";
import { createClient, listClients } from "@/lib/server/clients";
import { fail, ok, parseJsonBody } from "@/lib/server/http";
import { toPlain } from "@/lib/server/serialize";

const createClientBodySchema = z
  .object({
    name: z.string()
  })
  .strict();

export async function GET(req: NextRequest) {
  try {
    const { profile } = await requireAuth(req);
    ensureApproved(profile);

    const includeInactive = req.nextUrl.searchParams.get("includeInactive") === "true";
    const rows = await listClients(includeInactive && profile.role === "ADMIN");

    return ok({ items: toPlain(rows) });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { profile, uid } = await requireAuth(req);
    ensureApproved(profile);
    ensureRole(profile, ["ADMIN"]);

    const body = await parseJsonBody(req, createClientBodySchema);
    const created = await createClient(body.name, uid);

    return ok({ item: toPlain(created) }, 201);
  } catch (error) {
    return fail(error);
  }
}
