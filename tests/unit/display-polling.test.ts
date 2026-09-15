import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startDisplayPolling } from "@/lib/ui/display-polling";

class Visibility extends EventTarget {
  hidden = false;
  change(hidden: boolean) {
    this.hidden = hidden;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("display polling", () => {
  const stops: (() => void)[] = [];
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { stops.splice(0).forEach((stop) => stop()); vi.useRealTimers(); });
  function setup(load = vi.fn<(signal: AbortSignal) => Promise<number>>().mockResolvedValue(1), hidden = false) {
    const visibility = new Visibility();
    visibility.hidden = hidden;
    const onData = vi.fn();
    const onError = vi.fn();
    const stop = startDisplayPolling({ load, onData, onError, visibility, now: () => Date.now() });
    stops.push(stop);
    return { visibility, load, onData, onError, stop };
  }

  it("makes one initial plus 30 periodic calls in one visible hour", async () => {
    const { load, onData } = setup();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(load).toHaveBeenCalledTimes(31);
    expect(onData).toHaveBeenCalledTimes(31);
  });
  it("waits for completion before counting the next interval", async () => {
    const response = deferred<number>();
    const { load } = setup(vi.fn().mockReturnValueOnce(response.promise).mockResolvedValue(2));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(load).toHaveBeenCalledTimes(1);
    response.resolve(1);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("does not query when initially hidden and starts on becoming visible", async () => {
    const { visibility, load } = setup(undefined, true);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(load).not.toHaveBeenCalled();
    visibility.change(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
  });
  it("pauses hidden tabs and resumes once without catch-up calls", async () => {
    const { visibility, load } = setup();
    await vi.advanceTimersByTimeAsync(0);
    visibility.change(true);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(load).toHaveBeenCalledTimes(1);
    visibility.change(false);
    visibility.change(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(load).toHaveBeenCalledTimes(3);
  });
  it("throttles rapid returns to at most one start every 30 seconds", async () => {
    const { visibility, load } = setup();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 29; i++) {
      visibility.change(true); visibility.change(false);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("does not duplicate or abort an in-flight request on visibility changes", async () => {
    const response = deferred<number>();
    const { visibility, load, onData } = setup(vi.fn().mockReturnValue(response.promise));
    await vi.advanceTimersByTimeAsync(0);
    const signal = load.mock.calls[0][0];
    visibility.change(true); visibility.change(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(load).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(false);
    visibility.change(true);
    response.resolve(1);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(onData).toHaveBeenCalledWith(1);
    expect(load).toHaveBeenCalledTimes(1);
  });
  it("times out, reports failure and rejects late data even after a new success", async () => {
    const late = deferred<number>();
    const { load, onData, onError } = setup(vi.fn().mockReturnValueOnce(late.promise).mockResolvedValue(2));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(load.mock.calls[0][0].aborted).toBe(true);
    expect(onError.mock.calls[0][0].name).toBe("TimeoutError");
    await vi.advanceTimersByTimeAsync(119_999);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(onData).toHaveBeenCalledExactlyOnceWith(2);
    late.resolve(99);
    await vi.advanceTimersByTimeAsync(0);
    expect(onData).toHaveBeenCalledExactlyOnceWith(2);
    expect(onError).toHaveBeenCalledTimes(1);
  });
  it("retains normal retry cadence after failure despite visibility flapping", async () => {
    const { visibility, load, onError, onData } = setup(vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 119; i++) {
      visibility.change(true); visibility.change(false);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(onData).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(onData).toHaveBeenCalledExactlyOnceWith(2);
  });
  it("handles synchronous loader errors through the normal retry path", async () => {
    const { onError } = setup(vi.fn(() => { throw new Error("token"); }));
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);
  });
  it("cleans up before the initial call and can be mounted again", async () => {
    const first = setup(); first.stop();
    const second = setup();
    await vi.advanceTimersByTimeAsync(0);
    expect(first.load).not.toHaveBeenCalled();
    expect(second.load).toHaveBeenCalledTimes(1);
  });
  it("aborts on unmount, drops late failures and removes visibility listeners", async () => {
    const response = deferred<number>();
    const { stop, load, visibility, onError } = setup(vi.fn().mockReturnValue(response.promise));
    await vi.advanceTimersByTimeAsync(0);
    stop();
    expect(load.mock.calls[0][0].aborted).toBe(true);
    response.reject(new Error("late"));
    visibility.change(true); visibility.change(false);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(load).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("checks actual visibility again before a scheduled call", async () => {
    const { visibility, load } = setup();
    visibility.hidden = true;
    await vi.advanceTimersByTimeAsync(0);
    expect(load).not.toHaveBeenCalled();
  });
});
