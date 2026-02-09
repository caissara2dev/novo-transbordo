import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/server/auth";
import { fail, ok } from "@/lib/server/http";
import { toPlain } from "@/lib/server/serialize";

export async function GET(req: NextRequest) {
  try {
    const { profile } = await requireAuth(req);

    return ok({
      profile: toPlain(profile),
      approvalContactPhone: process.env.APPROVAL_CONTACT_PHONE || null
    });
  } catch (error) {
    return fail(error);
  }
}
