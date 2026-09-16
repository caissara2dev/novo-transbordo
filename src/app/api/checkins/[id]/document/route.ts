import type { NextRequest } from "next/server";
import { requireAuth,ensureApproved } from "@/lib/server/auth";
import { ok,fail } from "@/lib/server/http";
import { getDocumentDownload } from "@/lib/server/checkins/document-access";
export const runtime="nodejs";
export async function GET(request:NextRequest,context:{params:Promise<{id:string}>}) {
  try {
    const actor=await requireAuth(request);ensureApproved(actor.profile);
    return ok(await getDocumentDownload(actor,(await context.params).id,request.nextUrl.searchParams.get("preview")==="true"),{headers:{"Cache-Control":"private, no-store"}});
  } catch(e) {const response=fail(e);response.headers.set("Cache-Control","private, no-store");return response;}
}
