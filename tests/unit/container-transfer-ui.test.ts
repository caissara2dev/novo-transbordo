import { describe, expect, it } from "vitest";
import {
  makeInitialForm,
  toPayload
} from "@/app/(app)/events/event-model";

describe("container transfer event form", () => {
  it("starts productive launches with a truck as the load source", () => {
    const form = makeInitialForm();

    expect(form.loadSourceType).toBe("TRUCK");
    expect(form.sourceContainer).toBe("");
    expect(form.sourceContainerEmptied).toBeNull();
    expect(form.expectedSourceContainerStateVersion).toBeNull();
  });

  it("serializes the selected buffer container and its expected version", () => {
    const form = {
      ...makeInitialForm(),
      loadSourceType: "BUFFER_CONTAINER" as const,
      clientId: "client-1",
      plate: "",
      container: "MATU7654321",
      sourceContainer: "ABCU1234560",
      sourceContainerEmptied: false,
      expectedSourceContainerStateVersion: 7,
      expectedSourceContainerCycleId: "selected-cycle"
    };

    expect(toPayload(form)).toMatchObject({
      loadSourceType: "BUFFER_CONTAINER",
      sourceContainer: "ABCU1234560",
      sourceContainerEmptied: false,
      expectedSourceContainerStateVersion: 7,
      expectedSourceContainerCycleId: "selected-cycle",
      plate: null
    });
  });
});
