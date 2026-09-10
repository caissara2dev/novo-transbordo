import { NextRequest } from "next/server";
import { handleQueue } from "../../../checkins/queue-handler";
type Context = { params: Promise<{ id: string }> };
export async function GET(req: NextRequest, context: Context) { return handleQueue(req,true,(await context.params).id); }
export const PATCH = GET;
