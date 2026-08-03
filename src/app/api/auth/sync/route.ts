import { NextRequest } from "next/server";
import { z } from "zod";
import { requireVerifiedToken } from "@/lib/server/auth";
import { fail, ok, parseJsonBody } from "@/lib/server/http";
import { ensureUserProfile } from "@/lib/server/users";

const syncBodySchema = z
  .object({
    name: z.string().nullable().optional()
  })
  .strict();

export async function POST(req: NextRequest) {
  try {
    const decoded = await requireVerifiedToken(req);
    const body = await parseJsonBody(req, syncBodySchema, {
      allowEmpty: true
    });

    await ensureUserProfile({
      uid: decoded.uid,
      email: decoded.email || "",
      name: body?.name?.trim() || decoded.name || null
    });

    return ok({ synced: true });
  } catch (error) {
    return fail(error);
  }
}
