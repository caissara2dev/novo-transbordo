import type { CheckinStatus } from "@/lib/domain/checkins";
import type { UserRole } from "@/types/domain";

export type InternalCheckinListItem = {
  id: string;
  plate: string;
  driverName: string;
  carrierName: string;
  product: string;
  clientId: string | null;
  clientName: string | null;
  status: CheckinStatus;
  version: number;
};

export type CheckinRevision = {
  id: string;
  action?: string;
  actorRole?: string;
  reason?: string;
  createdAtIso?: string;
  fromStatus?: CheckinStatus;
  toStatus?: CheckinStatus;
  changedFields?: string[];
  highlight?: "GPS_BYPASS";
};

export type InternalCheckinDetail = InternalCheckinListItem & {
  clientNameSnapshot?: string | null;
  publicCode?: string;
  source?: "DRIVER" | "CARRIER";
  syncState?: string | null;
  driverLicense?: string;
  driverPhone?: string;
  vehicleType?: "Bitrem" | "Rodotrem" | "Vanderleia";
  originPlant?: string;
  originInvoiceNumbers?: string;
  remittanceInvoiceNumber?: string;
  geofence?: {
    allowed: boolean;
    distanceMeters: number;
    radiusMeters: number;
    accuracyMeters: number;
    validatedAtIso: string;
  } | null;
  locationOverride?: {
    applied: true;
    justification: string;
    approvedByRole: "SUPERVISOR" | "ADMIN";
    approvedAtIso: string;
  } | null;
  cancellationReason?: string | null;
  activeProductiveEventId?: string | null;
  createdAtIso?: string;
  updatedAtIso?: string;
  confirmedAtIso?: string | null;
  revisions?: CheckinRevision[];
};

export const checkinStatusOptions: ReadonlyArray<CheckinStatus> = [
  "PRE_CADASTRO",
  "AGUARDANDO_LIBERACAO",
  "AGUARDANDO_CHAMADA",
  "CHAMADO",
  "EM_DESCARGA",
  "CONCLUIDO",
  "CANCELADO"
];

const statusLabels: Record<CheckinStatus, string> = {
  PRE_CADASTRO: "Pré-cadastro",
  AGUARDANDO_LIBERACAO: "Aguardando liberação",
  AGUARDANDO_CHAMADA: "Aguardando chamada",
  CHAMADO: "Chamado",
  EM_DESCARGA: "Em descarga",
  CONCLUIDO: "Concluído",
  CANCELADO: "Cancelado"
};

export function canAccessCheckins(role: UserRole | null | undefined): boolean {
  return role === "OPERATOR" || role === "SUPERVISOR" || role === "ADMIN";
}

export function canManageCheckins(role: UserRole | null | undefined): boolean {
  return role === "SUPERVISOR" || role === "ADMIN";
}

export function statusLabel(status: CheckinStatus): string {
  return statusLabels[status];
}

export function filterCheckins(
  items: InternalCheckinListItem[],
  input: { query: string; status: CheckinStatus | "" }
): InternalCheckinListItem[] {
  const query = input.query.trim().toLocaleLowerCase("pt-BR");

  return items.filter((item) => {
    if (input.status && item.status !== input.status) return false;
    if (!query) return true;

    return [
      item.plate,
      item.driverName,
      item.carrierName,
      item.product,
      item.clientName ?? ""
    ].some((value) => value.toLocaleLowerCase("pt-BR").includes(query));
  });
}

export function formatCheckinDate(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Date(value).toLocaleString("pt-BR");
}

export function formatMeters(value: number | undefined): string {
  if (!Number.isFinite(value)) return "—";
  if ((value as number) >= 1_000) {
    return `${((value as number) / 1_000).toLocaleString("pt-BR", {
      maximumFractionDigits: 1
    })} km`;
  }
  return `${Math.round(value as number)} m`;
}
