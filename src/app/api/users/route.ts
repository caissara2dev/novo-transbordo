import { NextRequest } from "next/server";
import { ensureApproved, ensureRole, requireAuth } from "@/lib/server/auth";
import { fail, ok } from "@/lib/server/http";
import { toPlain } from "@/lib/server/serialize";
import { listUsers } from "@/lib/server/users";

export async function GET(req: NextRequest) {
  try {
    const { profile } = await requireAuth(req);

    ensureApproved(profile);
    ensureRole(profile, ["ADMIN"]);

    const rows = await listUsers();

    return ok({ items: toPlain(rows) });
  } catch (error) {
    return fail(error);
  }
}
