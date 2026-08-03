import { describe, expect, it } from "vitest";
import {
  decodePaginationCursor,
  encodePaginationCursor
} from "@/lib/server/pagination";

describe("opaque pagination cursors", () => {
  it("rejects timestamps outside the Firestore range", () => {
    const cursor = encodePaginationCursor({
      kind: "events",
      scope: "scope",
      values: [Number.MAX_VALUE],
      documentId: "event-1"
    });

    expect(() =>
      decodePaginationCursor({
        cursor,
        kind: "events",
        scope: "scope",
        valueTypes: ["timestamp-millis"]
      })
    ).toThrowError(expect.objectContaining({ status: 400 }));
  });

  it("rejects document ids that could be interpreted as paths", () => {
    const cursor = encodePaginationCursor({
      kind: "events",
      scope: "scope",
      values: [100],
      documentId: "events/event-1"
    });

    expect(() =>
      decodePaginationCursor({
        cursor,
        kind: "events",
        scope: "scope",
        valueTypes: ["timestamp-millis"]
      })
    ).toThrowError(expect.objectContaining({ status: 400 }));
  });
});
