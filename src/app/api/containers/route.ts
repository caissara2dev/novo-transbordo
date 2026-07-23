import { NextRequest } from "next/server";
import { containerStatuses, ContainerStatus } from "@/types/domain";
import { ensureApproved, requireAuth } from "@/lib/server/auth";
import { listContainerStates } from "@/lib/server/container-states";
import { HttpError } from "@/lib/domain/errors";
import { fail, ok } from "@/lib/server/http";
import { toPlain } from "@/lib/server/serialize";

export async function GET(req: NextRequest) {
  try {
    const { profile } = await requireAuth(req);
    ensureApproved(profile);

    const rawStatus = req.nextUrl.searchParams.get("status");
    if (rawStatus && !containerStatuses.includes(rawStatus as ContainerStatus)) {
      throw new HttpError(400, "Estado do container inválido.");
    }

    const items = await listContainerStates({
      query: req.nextUrl.searchParams.get("query") || undefined,
      openOnly: req.nextUrl.searchParams.get("scope") !== "all",
      status: (rawStatus as ContainerStatus | null) || undefined
    });

    return ok(toPlain({ items }));
  } catch (error) {
    return fail(error);
  }
}
