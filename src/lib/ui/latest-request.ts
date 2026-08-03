export type LatestRequestLease = {
  signal: AbortSignal;
  isCurrent: () => boolean;
};

export type LatestRequestCoordinator = {
  begin: () => LatestRequestLease;
  cancel: () => void;
};

export function createLatestRequestCoordinator(): LatestRequestCoordinator {
  let activeController: AbortController | null = null;

  return {
    begin() {
      activeController?.abort();

      const controller = new AbortController();
      activeController = controller;

      return {
        signal: controller.signal,
        isCurrent: () => activeController === controller && !controller.signal.aborted
      };
    },
    cancel() {
      activeController?.abort();
      activeController = null;
    }
  };
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
