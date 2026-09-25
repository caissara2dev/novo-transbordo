import { NextRequest } from "next/server";
import { requireAuth, ensureApproved, ensureRole } from "@/lib/server/auth";
import { adminDb } from "@/lib/firebase/admin";
import { ok, fail } from "@/lib/server/http";
import { documentBlocksCall } from "@/lib/domain/checkin-document";
import { documentHasExpired } from "@/lib/domain/document-retention";
import type { StoredCheckin } from "@/types/checkins";
import type { QueueIssue } from "@/lib/domain/queue";
export async function GET(req: NextRequest) {
  try {
    const { profile } = await requireAuth(req);
    ensureApproved(profile); ensureRole(profile, ["OPERATOR", "SUPERVISOR", "ADMIN"]);
    const enabled = process.env.CHECKIN_SYSTEM_RECORD_ENABLED === "true" &&
      ["observe", "enforce"].includes(process.env.CHECKIN_INTEGRATION_MODE ?? "off");
    if (!enabled) return ok({ enabled: false, mode: "off", items: [] });
    const mode = process.env.CHECKIN_INTEGRATION_MODE as "observe" | "enforce";
    const snap = await adminDb.collection("checkins").where("status", "==", "CHAMADO").get();
    const items = snap.docs.flatMap((row) => {
      const visit = row.data() as StoredCheckin & { clientId?: string; clientNameSnapshot?: string; issues?: QueueIssue[] };
      if (!visit.clientId || visit.activeProductiveEventId || visit.pendingOfficialMutation ||
          visit.issues?.some((issue) => !issue.resolved) || documentBlocksCall(visit.document) || documentHasExpired(visit)) return [];
      return [{ id: row.id, publicCode: visit.publicCode, plate: visit.plate, clientId: visit.clientId, clientName: visit.clientNameSnapshot, version: visit.version }];
    });
    return ok({ enabled: true, mode, items }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return fail(error); }
}
