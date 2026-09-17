import type { NextRequest } from "next/server";
import { requireAuth,ensureApproved } from "@/lib/server/auth";
import { ok,fail,parseJsonBody } from "@/lib/server/http";
import { HttpError } from "@/lib/domain/errors";
import { internalDocumentCommandSchema,runInternalDocumentCommand } from "@/lib/server/checkins/internal-documents";
import { getDocumentDownload, listDocumentVersions } from "@/lib/server/checkins/document-access";
export const runtime="nodejs";
export async function POST(request:NextRequest,context:{params:Promise<{id:string}>}) {
  try {
    if(process.env.CHECKIN_SYSTEM_RECORD_ENABLED!=="true") throw new HttpError(503,"Fila indisponível.");
    const actor=await requireAuth(request);ensureApproved(actor.profile);
    const result=await runInternalDocumentCommand(actor,(await context.params).id,await parseJsonBody(request,internalDocumentCommandSchema));
    return ok(result,{headers:{"Cache-Control":"private, no-store"}});
  } catch(e) {const response=fail(e);response.headers.set("Cache-Control","private, no-store");return response;}
}
export async function GET(request:NextRequest,context:{params:Promise<{id:string}>}) {
  try {
    const actor=await requireAuth(request);ensureApproved(actor.profile);
    const id=(await context.params).id;
    const params=request.nextUrl.searchParams;
    const result=params.get("history")==="true"
      ? await listDocumentVersions(actor,id,params.get("cursor") ?? undefined)
      : await getDocumentDownload(actor,id,params.get("preview")==="true",params.get("version") ?? undefined);
    return ok(result,{headers:{"Cache-Control":"private, no-store"}});
  } catch(e) {const response=fail(e);response.headers.set("Cache-Control","private, no-store");return response;}
}
