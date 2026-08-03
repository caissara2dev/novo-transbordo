import type { ContainerStateApiItem } from "@/types/api";

export function appendUniqueContainers(
  previous: readonly ContainerStateApiItem[],
  incoming: readonly ContainerStateApiItem[]
): ContainerStateApiItem[] {
  const knownContainers = new Set(previous.map((item) => item.container));

  return [
    ...previous,
    ...incoming.filter((item) => !knownContainers.has(item.container))
  ];
}
