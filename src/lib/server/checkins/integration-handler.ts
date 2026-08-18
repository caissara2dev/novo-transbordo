import "server-only";

import { z } from "zod";
import { HttpError } from "@/lib/domain/errors";
import { fail, ok } from "@/lib/server/http";
import { resolveCheckinRuntimeConfig } from "@/lib/server/checkins/config";
import { expireUnusedPreRegistrations } from "@/lib/server/checkins/expiration";
import { parseAndVerifyCheckinIntegrationRequest } from "@/lib/server/checkins/integration-request";
import {
  checkinConfirmationSchema,
  checkinExpirationSchema,
  checkinPreRegistrationSchema,
  checkinRecoverySchema,
  checkinStatusQuerySchema,
  checkinWalkInSchema
} from "@/lib/server/checkins/integration-schemas";
import { createPowerAutomateCheckinAdapterFromEnv } from "@/lib/server/checkins/power-automate-adapter";
import {
  getPublicCheckinStatus,
  resolvePublicCheckinVersion,
  type PublicCheckinStatus
} from "@/lib/server/checkins/public-query";
import {
  completeCheckinIntegrationRequest,
  failCheckinIntegrationRequest,
  hashCheckinIntegrationBody,
  reserveCheckinIntegrationRequest,
  type CheckinReplaySafeEnvelope,
  type CheckinReplayStore
} from "@/lib/server/checkins/replay-protection";
import {
  confirmCheckin,
  createOrRecoverPreRegistration,
  recoverPreRegistrationCode
} from "@/lib/server/checkins/service";
import type {
  CheckinExcelAdapter,
  PreRegistrationResult,
  PublicCheckinState
} from "@/types/checkins";

type Environment = Record<string, string | undefined>;

type ActiveRuntimeConfig = Exclude<
  ReturnType<typeof resolveCheckinRuntimeConfig>,
  { mode: "off" }
>;

type OperationContext = {
  config: ActiveRuntimeConfig;
  nowIso: string;
  requestId: string;
};

type OperationDefinition<Input, Data> = {
  name: string;
  schema: z.ZodType<Input>;
  successStatus: number;
  execute(
    input: Input,
    context: OperationContext,
    dependencies: CheckinIntegrationHandlerDependencies
  ): Promise<Data>;
  toReplay(data: Data): CheckinReplaySafeEnvelope;
  fromReplay(envelope: CheckinReplaySafeEnvelope): Data;
};

export type CheckinIntegrationHandlerDependencies = {
  environment?: Environment;
  now?: () => Date;
  replayStore?: CheckinReplayStore;
  excelAdapter?: CheckinExcelAdapter;
  createPreRegistration?: typeof createOrRecoverPreRegistration;
  resolveVersion?: typeof resolvePublicCheckinVersion;
  confirm?: typeof confirmCheckin;
  recover?: typeof recoverPreRegistrationCode;
  getStatus?: typeof getPublicCheckinStatus;
  expire?: typeof expireUnusedPreRegistrations;
};

type PreRegistrationData = {
  publicCode: string;
  recovered: boolean;
  version: number;
  publicStatus: "processing";
};

type ConfirmationData = {
  publicCode: string;
  version: number;
  publicStatus: "confirmed";
};

type RecoveryData = {
  publicCode: string;
  version: number;
  publicStatus: PublicCheckinStatus;
};

type StatusData = { publicStatus: PublicCheckinStatus };
type ExpirationData = { examined: number; expired: number; hasMore: boolean };

function parseRawJson(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    throw new HttpError(400, "Corpo da requisição inválido.");
  }
}

function replayConflict(): never {
  throw new HttpError(409, "Resposta idempotente inválida.");
}

function requiredReplayString(
  envelope: CheckinReplaySafeEnvelope,
  field: "publicCode" | "publicStatus"
): string {
  const value = envelope[field];
  if (typeof value !== "string") replayConflict();
  return value;
}

function requiredReplayVersion(envelope: CheckinReplaySafeEnvelope): number {
  if (!Number.isSafeInteger(envelope.version) || Number(envelope.version) <= 0) {
    replayConflict();
  }
  return envelope.version as number;
}

function requiredPublicStatus(value: string): PublicCheckinStatus {
  if (value !== "processing" && value !== "confirmed" && value !== "cancelled") {
    replayConflict();
  }
  return value;
}

function publicStatusOf(state: PublicCheckinState): PublicCheckinStatus {
  if (state.status === "CANCELADO") return "cancelled";
  if (state.status === "PRE_CADASTRO") return "processing";
  return "confirmed";
}

function errorCodeForReplay(error: unknown): string {
  if (error instanceof z.ZodError) return "VALIDATION_ERROR";
  if (error instanceof HttpError) {
    if (error.status === 503) return "DEPENDENCY_UNAVAILABLE";
    if (error.status >= 500) return "INTERNAL_ERROR";
    return error.code ?? "REQUEST_REJECTED";
  }
  return "INTERNAL_ERROR";
}

function requireExcelAdapter(
  dependencies: CheckinIntegrationHandlerDependencies
): CheckinExcelAdapter {
  if (dependencies.excelAdapter) return dependencies.excelAdapter;
  try {
    return createPowerAutomateCheckinAdapterFromEnv(
      dependencies.environment ?? process.env
    );
  } catch {
    // Configuration and endpoint details never cross the server boundary.
    throw new HttpError(503, "O registro oficial está temporariamente indisponível.");
  }
}

async function runOperation<Input, Data>(
  request: Request,
  definition: OperationDefinition<Input, Data>,
  dependencies: CheckinIntegrationHandlerDependencies
): Promise<Response> {
  const now = dependencies.now?.() ?? new Date();
  const nowIso = now.toISOString();
  let replayIdentity:
    | { requestId: string; bodyHash: string; operation: string; nowIso: string }
    | undefined;
  let reserved = false;

  try {
    const config = resolveCheckinRuntimeConfig(
      dependencies.environment ?? process.env
    );
    if (config.mode === "off") {
      throw new HttpError(503, "Integração de check-in indisponível.");
    }
    const verified = await parseAndVerifyCheckinIntegrationRequest(request, {
      mode: config.mode,
      activeKeyId: config.activeKeyId,
      secret: config.integrationSecret,
      nowMs: now.getTime()
    });
    replayIdentity = {
      requestId: verified.requestId,
      bodyHash: hashCheckinIntegrationBody(verified.rawBody),
      operation: definition.name,
      nowIso
    };
    const reservation = await reserveCheckinIntegrationRequest(
      replayIdentity,
      dependencies.replayStore
    );
    if (reservation.kind === "completed") {
      return ok(definition.fromReplay(reservation.envelope), reservation.httpStatus);
    }
    reserved = true;

    const input = definition.schema.parse(parseRawJson(verified.rawBody));
    const data = await definition.execute(
      input,
      { config, nowIso, requestId: verified.requestId },
      dependencies
    );
    const envelope = definition.toReplay(data);
    await completeCheckinIntegrationRequest(
      { ...replayIdentity, httpStatus: definition.successStatus, envelope },
      dependencies.replayStore
    );
    reserved = false;
    return ok(data, definition.successStatus);
  } catch (error) {
    if (reserved && replayIdentity) {
      await failCheckinIntegrationRequest(
        { ...replayIdentity, errorCode: errorCodeForReplay(error) },
        dependencies.replayStore
      ).catch(() => undefined);
    }
    return fail(error);
  }
}

const preRegistrationDefinition: OperationDefinition<
  z.infer<typeof checkinPreRegistrationSchema>,
  PreRegistrationData
> = {
  name: "pre-registration.create",
  schema: checkinPreRegistrationSchema,
  successStatus: 201,
  async execute(input, context, dependencies) {
    const result: PreRegistrationResult = await (
      dependencies.createPreRegistration ?? createOrRecoverPreRegistration
    )(
      {
        rawForm: input.form,
        source: input.source,
        nowIso: context.nowIso,
        requestId: context.requestId
      },
      { hmacSecret: context.config.indexSecret }
    );
    return {
      publicCode: result.publicCode,
      recovered: result.recovered,
      version: result.version,
      publicStatus: "processing"
    };
  },
  toReplay: (data) => ({ success: true, ...data }),
  fromReplay(envelope) {
    if (typeof envelope.recovered !== "boolean") replayConflict();
    return {
      publicCode: requiredReplayString(envelope, "publicCode"),
      recovered: envelope.recovered,
      version: requiredReplayVersion(envelope),
      publicStatus: requiredPublicStatus(requiredReplayString(envelope, "publicStatus")) === "processing"
        ? "processing"
        : replayConflict()
    };
  }
};

async function executeConfirmation(
  input: z.infer<typeof checkinConfirmationSchema>,
  context: OperationContext,
  dependencies: CheckinIntegrationHandlerDependencies,
  expectedVersion?: number
): Promise<ConfirmationData> {
  const version = expectedVersion ?? await (
    dependencies.resolveVersion ?? resolvePublicCheckinVersion
  )(
    {
      publicCode: input.publicCode,
      driverLicense: input.driverLicense,
      driverPhone: input.driverPhone,
      plate: input.plate
    },
    { hmacSecret: context.config.indexSecret }
  );
  const confirmed = await (dependencies.confirm ?? confirmCheckin)(
    {
      ...input,
      expectedVersion: version,
      nowIso: context.nowIso,
      requestId: context.requestId
    },
    {
      hmacSecret: context.config.indexSecret,
      allowedArea: context.config.allowedArea,
      excelAdapter: requireExcelAdapter(dependencies)
    }
  );
  return {
    publicCode: confirmed.publicCode,
    version: confirmed.version,
    publicStatus: "confirmed"
  };
}

const confirmationReplay = {
  toReplay: (data: ConfirmationData): CheckinReplaySafeEnvelope => ({
    success: true,
    ...data
  }),
  fromReplay(envelope: CheckinReplaySafeEnvelope): ConfirmationData {
    if (requiredReplayString(envelope, "publicStatus") !== "confirmed") replayConflict();
    return {
      publicCode: requiredReplayString(envelope, "publicCode"),
      version: requiredReplayVersion(envelope),
      publicStatus: "confirmed"
    };
  }
};

const confirmationDefinition: OperationDefinition<
  z.infer<typeof checkinConfirmationSchema>,
  ConfirmationData
> = {
  name: "check-in.confirm",
  schema: checkinConfirmationSchema,
  successStatus: 200,
  execute: executeConfirmation,
  ...confirmationReplay
};

const walkInDefinition: OperationDefinition<
  z.infer<typeof checkinWalkInSchema>,
  ConfirmationData
> = {
  name: "walk-in.create-and-confirm",
  schema: checkinWalkInSchema,
  successStatus: 201,
  async execute(input, context, dependencies) {
    const preRegistration = await (
      dependencies.createPreRegistration ?? createOrRecoverPreRegistration
    )(
      {
        rawForm: input.form,
        source: "DRIVER",
        nowIso: context.nowIso,
        requestId: context.requestId
      },
      { hmacSecret: context.config.indexSecret }
    );
    return executeConfirmation(
      {
        publicCode: preRegistration.publicCode,
        driverLicense: input.form.driverLicense,
        driverPhone: input.form.driverPhone,
        plate: input.form.plate,
        location: input.location
      },
      context,
      dependencies,
      preRegistration.version
    );
  },
  ...confirmationReplay
};

const recoveryDefinition: OperationDefinition<
  z.infer<typeof checkinRecoverySchema>,
  RecoveryData
> = {
  name: "pre-registration.recover",
  schema: checkinRecoverySchema,
  successStatus: 200,
  async execute(input, context, dependencies) {
    const recovered = await (dependencies.recover ?? recoverPreRegistrationCode)(
      { ...input, nowIso: context.nowIso },
      { hmacSecret: context.config.indexSecret }
    );
    return {
      publicCode: recovered.publicCode,
      version: recovered.version,
      publicStatus: publicStatusOf(recovered)
    };
  },
  toReplay: (data) => ({ success: true, ...data }),
  fromReplay(envelope) {
    return {
      publicCode: requiredReplayString(envelope, "publicCode"),
      version: requiredReplayVersion(envelope),
      publicStatus: requiredPublicStatus(requiredReplayString(envelope, "publicStatus"))
    };
  }
};

const statusDefinition: OperationDefinition<
  z.infer<typeof checkinStatusQuerySchema>,
  StatusData
> = {
  name: "check-in.status",
  schema: checkinStatusQuerySchema,
  successStatus: 200,
  async execute(input, context, dependencies) {
    const result = await (dependencies.getStatus ?? getPublicCheckinStatus)(input, {
      hmacSecret: context.config.indexSecret
    });
    return { publicStatus: result.status };
  },
  toReplay: (data) => ({ success: true, ...data }),
  fromReplay: (envelope) => ({
    publicStatus: requiredPublicStatus(requiredReplayString(envelope, "publicStatus"))
  })
};

const expirationDefinition: OperationDefinition<
  z.infer<typeof checkinExpirationSchema>,
  ExpirationData
> = {
  name: "maintenance.expire-pre-registrations",
  schema: checkinExpirationSchema,
  successStatus: 200,
  execute: async (input, context, dependencies) =>
    (dependencies.expire ?? expireUnusedPreRegistrations)({
      nowIso: context.nowIso,
      limit: input.limit
    }),
  toReplay: (data) => ({ success: true, ...data }),
  fromReplay(envelope) {
    if (
      !Number.isSafeInteger(envelope.examined) ||
      Number(envelope.examined) < 0 ||
      !Number.isSafeInteger(envelope.expired) ||
      Number(envelope.expired) < 0 ||
      typeof envelope.hasMore !== "boolean"
    ) {
      replayConflict();
    }
    return {
      examined: envelope.examined as number,
      expired: envelope.expired as number,
      hasMore: envelope.hasMore as boolean
    };
  }
};

export const handleCheckinPreRegistration = (
  request: Request,
  dependencies: CheckinIntegrationHandlerDependencies = {}
) => runOperation(request, preRegistrationDefinition, dependencies);

export const handleCheckinConfirmation = (
  request: Request,
  dependencies: CheckinIntegrationHandlerDependencies = {}
) => runOperation(request, confirmationDefinition, dependencies);

export const handleCheckinWalkIn = (
  request: Request,
  dependencies: CheckinIntegrationHandlerDependencies = {}
) => runOperation(request, walkInDefinition, dependencies);

export const handleCheckinRecovery = (
  request: Request,
  dependencies: CheckinIntegrationHandlerDependencies = {}
) => runOperation(request, recoveryDefinition, dependencies);

export const handleCheckinStatus = (
  request: Request,
  dependencies: CheckinIntegrationHandlerDependencies = {}
) => runOperation(request, statusDefinition, dependencies);

export const handleCheckinExpiration = (
  request: Request,
  dependencies: CheckinIntegrationHandlerDependencies = {}
) => runOperation(request, expirationDefinition, dependencies);
