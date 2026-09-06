import { normalizeContainer } from "./identifiers.ts";
import { HttpError } from "./errors.ts";
import {
  planContainerTimeline,
  type ContainerTimelineEvent
} from "./container-timeline.ts";
import { containerStatuses } from "../../types/domain.ts";
import type {
  ContainerEventRole,
  ContainerLifecycleStatus,
  ContainerStateDoc,
  ContainerStatus,
  EventDoc
} from "../../types/domain.ts";

export function eventContainerStatus(data: {
  containerStatus?: unknown;
  category?: unknown;
  container?: unknown;
}): ContainerStatus | null {
  if (containerStatuses.includes(data.containerStatus as ContainerStatus))
    return data.containerStatus as ContainerStatus;
  return data.category === "PRODUTIVO" && data.container ? "FULL" : null;
}

export type EventEffect = ContainerTimelineEvent & {
  role: ContainerEventRole;
  reason: string | null;
  clientNameSnapshot: string | null;
  relatedContainer: string | null;
  data: EventDoc;
};

export type ContainerEventRecord = { id: string; data: EventDoc };

function toMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (value && typeof value === "object" && "toMillis" in value) {
    return Number((value as { toMillis: () => number }).toMillis());
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function isActive(data: EventDoc | null): data is EventDoc {
  return Boolean(data && !data.deleted);
}

export function containersAffectedBy(data: EventDoc | null): string[] {
  if (!isActive(data)) return [];
  const source =
    data.loadSourceType === "BUFFER_CONTAINER"
      ? normalizeContainer(data.sourceContainer ?? null)
      : null;
  return [normalizeContainer(data.container), source].filter(
    (value): value is string => Boolean(value)
  );
}

export function effectForContainer(
  id: string,
  data: EventDoc,
  container: string
): EventEffect | null {
  const destination = normalizeContainer(data.container);
  const source = normalizeContainer(data.sourceContainer ?? null);
  const role: ContainerEventRole | null =
    destination === container
      ? "DESTINATION"
      : data.loadSourceType === "BUFFER_CONTAINER" && source === container
        ? "SOURCE"
        : null;
  if (!role || !data.clientId) return null;

  const status: ContainerLifecycleStatus | null =
    role === "DESTINATION"
      ? eventContainerStatus(data)
      : data.sourceContainerEmptied
        ? "TRANSFER_EMPTIED"
        : "BUFFER";
  if (!status) return null;

  return {
    id,
    container,
    status,
    clientId: data.clientId,
    plate: data.plate || null,
    pump: data.pump,
    operationalAtMs: toMillis(data.endAt),
    createdAtMs: toMillis(data.createdAt),
    startsNewCycle:
      role === "DESTINATION" ? Boolean(data.startsNewContainerCycle) : false,
    existingCycleId:
      role === "DESTINATION"
        ? data.containerCycleId || null
        : data.sourceContainerCycleId || null,
    role,
    reason: role === "DESTINATION" ? data.containerReason || null : null,
    clientNameSnapshot: data.clientNameSnapshot || null,
    relatedContainer: role === "DESTINATION" ? source : destination,
    data,
    fromContainerTransfer:
      role === "DESTINATION" && data.loadSourceType === "BUFFER_CONTAINER",
    legacyClosedCycleBoundary:
      role === "DESTINATION" &&
      !data.loadSourceType &&
      !data.containerCycleId &&
      !data.previousContainerEventId &&
      !data.startsNewContainerCycle &&
      (status === "FULL" || status === "BLEND_FULL")
  };
}

export function projectionFromPlan(params: {
  effects: EventEffect[];
  links: Array<{
    id: string;
    containerCycleId: string;
    previousContainerEventId: string | null;
  }>;
  current: EventEffect;
  version: number;
}): Omit<ContainerStateDoc, "updatedAt"> {
  const linksById = new Map(params.links.map((link) => [link.id, link]));
  const currentLink = linksById.get(params.current.id);
  if (!currentLink) {
    throw new HttpError(
      500,
      "Não foi possível reconstruir o estado do container."
    );
  }
  const currentCycleEffects = params.effects
    .filter(
      (effect) =>
        linksById.get(effect.id)?.containerCycleId ===
        currentLink.containerCycleId
    )
    .sort(
      (left, right) =>
        left.operationalAtMs - right.operationalAtMs ||
        left.createdAtMs - right.createdAtMs ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    );
  const previousWithPlate = [...currentCycleEffects]
    .reverse()
    .find((effect) => effect.plate);
  const previousWithReason = [...currentCycleEffects]
    .reverse()
    .find((effect) => effect.reason);
  const preserveSourceMetadata = params.current.role === "SOURCE";

  return {
    container: params.current.container,
    status: params.current.status,
    reason: preserveSourceMetadata
      ? previousWithReason?.reason || null
      : params.current.reason,
    cycleId: currentLink.containerCycleId,
    latestEventId: params.current.id,
    previousEventId: currentLink.previousContainerEventId,
    clientId: params.current.clientId,
    clientNameSnapshot: params.current.clientNameSnapshot,
    plate: preserveSourceMetadata
      ? previousWithPlate?.plate || null
      : params.current.plate,
    pump: params.current.pump,
    latestEventRole: params.current.role,
    relatedContainer: params.current.relatedContainer,
    operationalAt: params.current.data.endAt,
    eventCreatedAt: params.current.data.createdAt,
    version: params.version
  };
}

export function planEffectsForContainer(
  container: string,
  records: ContainerEventRecord[],
  createCycleId: () => string
) {
  const effects = records
    .map(({ id, data }) => effectForContainer(id, data, container))
    .filter((effect): effect is EventEffect => Boolean(effect));
  const plan = planContainerTimeline({ events: effects, createCycleId });
  const resolved = new Map(plan.events.map((event) => [event.id, event]));
  return {
    effects: effects.map((effect) => ({
      ...effect,
      ...resolved.get(effect.id)!
    })),
    plan
  };
}
