import { NextRequest } from "next/server";
import { handleQueue } from "../queue-handler";
type Context = { params: Promise<{ id: string }> };
export async function GET(req: NextRequest, context: Context) { return handleQueue(req,false,(await context.params).id); }
export const PATCH = GET;
