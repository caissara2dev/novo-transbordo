import { ContainerCyclePassage, ContainerStatus, Pump } from "@/types/domain";

export type ContainerCycleHistoryEntry = {
  id: string;
  containerCycleId: string | null;
  previousContainerEventId: string | null;
  startTime: string;
  endTime: string;
  pump: Pump;
  plate: string | null;
  status: ContainerStatus;
  deleted: boolean;
};

export function collectPreviousContainerPassages(
  current: ContainerCycleHistoryEntry,
  eventsById: ReadonlyMap<string, ContainerCycleHistoryEntry>
): ContainerCyclePassage[] {
  if (!current.containerCycleId || !current.previousContainerEventId) {
    return [];
  }

  const passages: ContainerCyclePassage[] = [];
  const visited = new Set<string>([current.id]);
  let previousId: string | null = current.previousContainerEventId;

  while (previousId && !visited.has(previousId)) {
    visited.add(previousId);
    const previous = eventsById.get(previousId);
    if (!previous || previous.containerCycleId !== current.containerCycleId) {
      break;
    }

    if (!previous.deleted) {
      passages.push({
        id: previous.id,
        startTime: previous.startTime,
        endTime: previous.endTime,
        pump: previous.pump,
        plate: previous.plate,
        status: previous.status
      });
    }

    previousId = previous.previousContainerEventId;
  }

  return passages.reverse();
}
