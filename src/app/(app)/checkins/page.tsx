import { RoleGuard } from "@/components/role-guard";
import { LiveQueue } from "@/components/queue/live-workspace";
export default function Page() { return <RoleGuard allowed={["ANALYST","SUPERVISOR","ADMIN"]}><LiveQueue /></RoleGuard>; }
