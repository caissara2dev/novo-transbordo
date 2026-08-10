import { handleCheckinConfirmation } from "@/lib/server/checkins/integration-handler";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return handleCheckinConfirmation(request);
}
