export const DISPLAY_REFRESH_INTERVAL_MS = 120_000;
export const DISPLAY_RETURN_INTERVAL_MS = 30_000;
export const DISPLAY_REQUEST_TIMEOUT_MS = 30_000;

type Visibility = Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;

type PollingOptions<T> = {
  load: (signal: AbortSignal) => Promise<T>;
  onData: (data: T) => void;
  onError: (error: unknown) => void;
  visibility?: Visibility;
  now?: () => number;
};

/** One timer and one request per mounted display; no catch-up queue. */
export function startDisplayPolling<T>({
  load,
  onData,
  onError,
  visibility = document,
  now = () => performance.now()
}: PollingOptions<T>): () => void {
  let disposed = false;
  let hidden = visibility.hidden;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastStarted = -Infinity;
  let retryNotBefore = -Infinity;
  let active: {
    controller: AbortController;
    deadline: ReturnType<typeof setTimeout>;
  } | undefined;

  function clearTimer() {
    clearTimeout(timer);
    timer = undefined;
  }

  function schedule(delay: number) {
    clearTimer();
    if (!disposed && !visibility.hidden && !active) {
      timer = setTimeout(run, delay);
    }
  }

  function run() {
    timer = undefined;
    if (disposed || visibility.hidden || active) return;

    lastStarted = now();
    const controller = new AbortController();
    const request = {
      controller,
      deadline: setTimeout(() => {
        const error = new DOMException("Tempo de atualização excedido.", "TimeoutError");
        controller.abort(error);
        finish({ ok: false, error });
      }, DISPLAY_REQUEST_TIMEOUT_MS)
    };
    active = request;

    function finish(result: { ok: true; data: T } | { ok: false; error: unknown }) {
      // A timed-out or unmounted request may still settle after its replacement.
      if (disposed || active !== request) return;
      clearTimeout(request.deadline);
      active = undefined;
      if (result.ok) {
        retryNotBefore = -Infinity;
        onData(result.data);
      } else {
        retryNotBefore = now() + DISPLAY_REFRESH_INTERVAL_MS;
        onError(result.error);
      }
      schedule(DISPLAY_REFRESH_INTERVAL_MS);
    }

    Promise.resolve().then(() => {
      if (controller.signal.aborted) throw controller.signal.reason;
      return load(controller.signal);
    }).then(
      (data) => finish({ ok: true, data }),
      (error: unknown) => finish({ ok: false, error })
    );
  }

  function onVisibilityChange() {
    const wasHidden = hidden;
    hidden = visibility.hidden;
    if (hidden) {
      clearTimer();
    } else if (wasHidden && !active) {
      schedule(Math.max(0, lastStarted + DISPLAY_RETURN_INTERVAL_MS - now(), retryNotBefore - now()));
    }
  }

  visibility.addEventListener("visibilitychange", onVisibilityChange);
  // Deferring also lets React's development setup/cleanup cancel the first run.
  schedule(0);
  return () => {
    disposed = true;
    clearTimer();
    visibility.removeEventListener("visibilitychange", onVisibilityChange);
    if (active) {
      clearTimeout(active.deadline);
      active.controller.abort();
      active = undefined;
    }
  };
}
