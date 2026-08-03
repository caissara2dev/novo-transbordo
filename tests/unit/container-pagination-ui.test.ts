import { describe, expect, it } from "vitest";
import { appendUniqueContainers } from "@/lib/ui/container-pagination";
import type { ContainerStateApiItem } from "@/types/api";

function container(
  code: string,
  status: ContainerStateApiItem["status"] = "PARTIAL"
): ContainerStateApiItem {
  return {
    container: code,
    status,
    operationalAt: "2026-07-28T12:00:00.000Z",
    eventCreatedAt: "2026-07-28T12:00:00.000Z",
    updatedAt: "2026-07-28T12:00:00.000Z"
  } as ContainerStateApiItem;
}

describe("container pagination UI", () => {
  it("appends a page immutably without duplicating containers", () => {
    const previous = [container("ABCU 123456-0"), container("DEFU 123456-0")];
    const incoming = [
      container("DEFU 123456-0", "FULL"),
      container("GHIU 123456-0")
    ];

    const result = appendUniqueContainers(previous, incoming);

    expect(result).toEqual([
      previous[0],
      previous[1],
      incoming[1]
    ]);
    expect(result).not.toBe(previous);
    expect(previous[1].status).toBe("PARTIAL");
  });
});
