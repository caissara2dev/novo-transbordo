import type {
  CheckinGeofenceResult,
  CheckinStatus,
  DriverCheckinForm
} from "@/lib/domain/checkins";
import type { UserRole } from "@/types/domain";

export type CheckinSource = "DRIVER" | "CARRIER";

export type CheckinSyncState =
  | "PENDENTE"
  | "EM_PROCESSAMENTO"
  | "CONFIRMADO"
  | "FALHA_RETRY";

export type PublicCheckinState = {
  publicCode: string;
  status: CheckinStatus;
  syncState: CheckinSyncState | null;
  version: number;
};

export type PendingOfficialMutation = {
  token: string;
  kind: "CORRECTION" | "LOCATION_OVERRIDE";
  state: "EM_PROCESSAMENTO" | "FALHA_RETRY";
  payloadHash: string;
  baseVersion: number;
  reservedVersion: number;
  requestedByUid: string;
  requestedByRole: Extract<UserRole, "SUPERVISOR" | "ADMIN">;
  reason: string;
  startedAtIso: string;
  lastAttemptAtIso: string;
  patch?: Partial<DriverCheckinForm>;
  nextIndexes?: Pick<
    StoredCheckin,
    "driverLicenseIndex" | "driverPhoneIndex" | "plateIndex"
  >;
};

export type PreRegistrationResult = PublicCheckinState & {
  recovered: boolean;
};

export type StoredCheckin = DriverCheckinForm & {
  id: string;
  publicCode: string;
  source: CheckinSource;
  status: CheckinStatus;
  syncState: CheckinSyncState | null;
  driverLicenseIndex: string;
  driverPhoneIndex: string;
  plateIndex: string;
  geofence: CheckinGeofenceResult | null;
  cancellationReason: string | null;
  /** Event that currently owns the CHAMADO -> EM_DESCARGA transition. */
  activeProductiveEventId?: string | null;
  /** Durable reservation that serializes an Excel-backed manager mutation. */
  pendingOfficialMutation?: PendingOfficialMutation | null;
  version: number;
  createdAtIso: string;
  updatedAtIso: string;
  confirmedAtIso: string | null;
};

export type ExcelCheckinRecord = {
  publicCode: string;
  form: DriverCheckinForm;
  startedAtIso: string;
};

export type CheckinExcelAdapter = {
  includeIdempotently(
    record: ExcelCheckinRecord
  ): Promise<{ confirmedAtIso: string }>;
};

export type CheckinGeofenceInput = {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  capturedAtIso: string;
};

export type CheckinAllowedArea = {
  latitude: number;
  longitude: number;
  radiusMeters: number;
};
