import { NextRequest } from "next/server";
import { ensureApproved, requireAuth } from "@/lib/server/auth";
import { getContainerHistory } from "@/lib/server/container-states";
import { fail, ok } from "@/lib/server/http";
import { parsePagination } from "@/lib/server/pagination";
import { toPlain } from "@/lib/server/serialize";

export async function GET(req: NextRequest) {
  try {
    const { profile } = await requireAuth(req);
    ensureApproved(profile);

    const container = req.nextUrl.searchParams.get("container") || "";
    const page = await getContainerHistory(container, parsePagination(req.nextUrl.searchParams));
    return ok(toPlain(page));
  } catch (error) {
    return fail(error);
  }
}
