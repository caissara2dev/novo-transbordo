import { NextRequest } from "next/server";
import { handleQueue } from "../../checkins/queue-handler";
export const GET = (req: NextRequest) => handleQueue(req,true);
