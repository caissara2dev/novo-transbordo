import { fail, ok } from "@/lib/server/http";
import { resolveCheckinRuntimeConfig } from "@/lib/server/checkins/config";
import { parseAndVerifyCheckinIntegrationRequest } from "@/lib/server/checkins/integration-request";
import { documentCommandSchema, runDocumentCommand } from "@/lib/server/checkins/documents";
import { HttpError } from "@/lib/domain/errors";
export const runtime="nodejs";
export async function POST(request:Request) {
  try {
    const config=resolveCheckinRuntimeConfig(process.env);
    if(config.mode==="off") throw new HttpError(503,"Integração indisponível.");
    const verified=await parseAndVerifyCheckinIntegrationRequest(request,{mode:config.mode,activeKeyId:config.activeKeyId,secret:config.integrationSecret,nowMs:Date.now()});
    const result=await runDocumentCommand(documentCommandSchema.parse(JSON.parse(verified.rawBody)));
    return ok(result,{headers:{"Cache-Control":"private, no-store"}});
  } catch(e) { const response=fail(e);response.headers.set("Cache-Control","private, no-store");return response; }
}
