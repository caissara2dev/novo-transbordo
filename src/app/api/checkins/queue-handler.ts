import { NextRequest } from "next/server";
import { requireAuth, ensureApproved } from "@/lib/server/auth";
import { HttpError } from "@/lib/domain/errors";
import { fail, ok, parseJsonBody } from "@/lib/server/http";
import { getQueueVisit, listQueuePage, mutateQueue, queueCommandSchema } from "@/lib/server/checkins/queue-service";
export async function handleQueue(req: NextRequest, customer: boolean, id?: string) {
  try {
    if (process.env.CHECKIN_SYSTEM_RECORD_ENABLED !== "true") throw new HttpError(503,"Fila indisponível.");
    const context = await requireAuth(req); ensureApproved(context.profile);
    if ((context.profile.role === "CUSTOMER") !== customer) throw new HttpError(403,"Acesso não autorizado.");
    const actor = { uid: context.uid, profile: context.profile };
    const result = req.method === "PATCH" && id
      ? { item: await mutateQueue(actor,id,await parseJsonBody(req,queueCommandSchema)) }
      : id ? { item: await getQueueVisit(actor,id) } : await listQueuePage(actor,req.nextUrl.searchParams.get("cursor") ?? undefined);
    return ok(result,{ headers: { "Cache-Control": "private, no-store" } });
  } catch(error) { const response = fail(error); response.headers.set("Cache-Control","private, no-store"); return response; }
}
