import { NextRequest } from "next/server";
import { handleQueue } from "./queue-handler";
export const GET = (req: NextRequest) => handleQueue(req,false);
