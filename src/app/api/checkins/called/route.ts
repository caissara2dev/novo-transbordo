import { NextRequest } from "next/server";
import { requireAuth,ensureApproved,ensureRole } from "@/lib/server/auth";
import { adminDb } from "@/lib/firebase/admin";
import { ok,fail } from "@/lib/server/http";
export async function GET(req: NextRequest) {
  try {
    const {profile} = await requireAuth(req);ensureApproved(profile);ensureRole(profile,["OPERATOR","SUPERVISOR","ADMIN"]);
    const enabled = process.env.CHECKIN_SYSTEM_RECORD_ENABLED === "true" && ["observe","enforce"].includes(process.env.CHECKIN_INTEGRATION_MODE ?? "off");
    if (!enabled) return ok({enabled:false,items:[]});
    const snap = await adminDb.collection("checkins").where("status","==","CHAMADO").get();
    return ok({enabled:true,items:snap.docs.filter(d => !(d.data().issues ?? []).some((i:{resolved:boolean})=>!i.resolved)).map(d=>({id:d.id,plate:d.data().plate,clientId:d.data().clientId,clientName:d.data().clientNameSnapshot,version:d.data().version}))},{headers:{"Cache-Control":"private, no-store"}});
  } catch(e) {return fail(e);}
}
