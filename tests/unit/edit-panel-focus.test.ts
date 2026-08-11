import { describe, expect, it, vi } from "vitest";
import { revealEditHeading } from "@/lib/ui/edit-panel-focus";

describe("revealEditHeading", () => {
  it("scrolls the selected edit heading into view and moves focus to it", () => {
    const scrollIntoView = vi.fn();
    const focus = vi.fn();

    revealEditHeading({ scrollIntoView, focus });

    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "auto",
      block: "start"
    });
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("does nothing while the edit heading is not mounted", () => {
    expect(() => revealEditHeading(null)).not.toThrow();
  });
});
