import { HttpError } from "./errors.ts";
import { isTransferSourceStatus, resolveTransferSourceStatus } from "./container-transfer.ts";
import type {
  ContainerEventRole,
  ContainerLifecycleStatus,
  ContainerStatus,
  Pump
} from "../../types/domain.ts";

export type ContainerTimelineEvent = {
  id: string;
  container: string;
  status: ContainerLifecycleStatus;
  clientId: string;
  plate: string | null;
  pump: Pump;
  operationalAtMs: number;
  createdAtMs: number;
  startsNewCycle: boolean;
  existingCycleId: string | null;
  role?: ContainerEventRole;
  fromContainerTransfer?: boolean;
  legacyClosedCycleBoundary?: boolean;
};

export type ContainerTimelineLink = {
  id: string;
  containerCycleId: string;
  previousContainerEventId: string | null;
};

export type ContainerTimelinePlan = {
  events: Array<ContainerTimelineEvent & ContainerTimelineLink>;
  current: (ContainerTimelineEvent & ContainerTimelineLink) | null;
};

// Firestore allows 500 writes per transaction. Keeping 50 writes in reserve
// leaves room for locks, revisions and automatic gap reconciliation.
export const TIMELINE_TRANSACTION_WRITE_LIMIT = 450;
// Online reconciliation must read the complete history or fail before planning.
export const TIMELINE_TRANSACTION_EVENT_READ_LIMIT = 1_000;

export function assertTimelineReconciliationEventBudget(eventCount: number): void {
  if (eventCount > TIMELINE_TRANSACTION_EVENT_READ_LIMIT) {
    throw new HttpError(
      409,
      `O histórico do container excede o limite de ${TIMELINE_TRANSACTION_EVENT_READ_LIMIT} eventos para reconciliação online. Solicite uma revisão administrativa antes de alterar esta linha do tempo.`
    );
  }
}

export function assertTimelineTransactionWriteBudget(params: {
  lifecycleWrites: number;
  reservedWrites: number;
}): void {
  if (
    params.lifecycleWrites + params.reservedWrites >
    TIMELINE_TRANSACTION_WRITE_LIMIT
  ) {
    throw new HttpError(
      409,
      "A reconciliação excederia o limite seguro de 450 escritas. Divida o histórico ou execute uma reparação administrativa."
    );
  }
}

function isBlend(status: ContainerLifecycleStatus): boolean {
  return status === "BLEND_FULL" || status === "BLEND_PARTIAL";
}

function isClosed(status: ContainerLifecycleStatus): boolean {
  return (
    status === "FULL" ||
    status === "BLEND_FULL" ||
    status === "TRANSFER_EMPTIED"
  );
}

export function planContainerTimeline(params: {
  events: ContainerTimelineEvent[];
  createCycleId: () => string;
}): ContainerTimelinePlan {
  const ordered = [...params.events].sort(
    (left, right) =>
      left.operationalAtMs - right.operationalAtMs ||
      left.createdAtMs - right.createdAtMs ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );

  const planned: Array<ContainerTimelineEvent & ContainerTimelineLink> = [];

  for (const [index, input] of ordered.entries()) {
    const event = { ...input };
    const previous = planned.at(-1) || null;
    const followsEmptiedTransfer = previous?.status === "TRANSFER_EMPTIED";
    const followsIndependentLegacyCycle = Boolean(
      previous?.legacyClosedCycleBoundary &&
        event.existingCycleId &&
        event.existingCycleId !== previous.containerCycleId
    );
    const startsNewCycle =
      !previous ||
      event.startsNewCycle ||
      event.legacyClosedCycleBoundary ||
      followsEmptiedTransfer ||
      followsIndependentLegacyCycle;

    if (startsNewCycle) {
      if (event.role === "SOURCE") {
        throw new HttpError(
          400,
          "A origem da transferência exige um container Pulmão ou Parcial aberto."
        );
      }
      if (isBlend(event.status) && !event.legacyClosedCycleBoundary) {
        throw new HttpError(
          400,
          previous
            ? "Um novo ciclo não pode começar diretamente como Blend."
            : "Blend exige um container Parcial ou Pulmão anterior."
        );
      }

      const next = ordered[index + 1];
      const inheritedCycleId =
        !previous && !event.startsNewCycle && next && !next.startsNewCycle
          ? next.existingCycleId
          : null;
      planned.push({
        ...event,
        containerCycleId:
          event.existingCycleId || inheritedCycleId || params.createCycleId(),
        previousContainerEventId: null
      });
      continue;
    }

    if (event.role === "SOURCE") {
      if (
        !isTransferSourceStatus(event.status) &&
        event.status !== "TRANSFER_EMPTIED"
      ) {
        throw new HttpError(
          400,
          "Estado inválido para a origem da transferência."
        );
      }
      event.status = resolveTransferSourceStatus({
        previousStatus: previous.status,
        previousClientId: previous.clientId,
        clientId: event.clientId,
        emptied: event.status === "TRANSFER_EMPTIED"
      });
    } else if (isClosed(previous.status)) {
      throw new HttpError(
        409,
        "Este container estava cheio. Confirme que foi esvaziado para iniciar um novo ciclo."
      );
    }

    if (previous.status === "BLEND_PARTIAL" && !isBlend(event.status)) {
      throw new HttpError(
        400,
        "Um Blend não pode voltar a ser carga simples no mesmo ciclo."
      );
    }

    if (
      (isBlend(event.status) || event.fromContainerTransfer) &&
      previous.clientId !== event.clientId
    ) {
      throw new HttpError(
        400,
        event.fromContainerTransfer
          ? "A origem e o destino devem pertencer ao mesmo cliente."
          : "Blend só pode ser formado com cargas do mesmo cliente."
      );
    }

    planned.push({
      ...event,
      containerCycleId: previous.containerCycleId,
      previousContainerEventId: previous.id
    });
  }

  return {
    events: planned,
    current: planned.at(-1) || null
  };
}

export function availableStatusesFor(
  current: { status: ContainerLifecycleStatus } | null,
  startsNewCycle = false
): ContainerStatus[] {
  if (!current || startsNewCycle) {
    return ["FULL", "PARTIAL", "BUFFER"];
  }

  if (current.status === "BLEND_FULL" || current.status === "BLEND_PARTIAL") {
    return ["BLEND_FULL", "BLEND_PARTIAL"];
  }

  if (current.status === "PARTIAL" || current.status === "BUFFER") {
    return ["FULL", "PARTIAL", "BUFFER", "BLEND_FULL", "BLEND_PARTIAL"];
  }

  return ["FULL", "PARTIAL", "BUFFER"];
}
