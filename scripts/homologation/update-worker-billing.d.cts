export type Options = {
  project: string;
  region: string;
  service: string;
  apply: boolean;
  evidenceDir: string | null;
};

export type Container = {
  resources: Record<string, unknown>;
  [key: string]: unknown;
};

export type Snapshot = {
  capturedAt: string;
  [key: string]: unknown;
};

export type Request = (
  host: string,
  path: string,
  method?: string,
  body?: unknown
) => Promise<unknown>;

export const TARGET: Readonly<{ project: string; region: string; service: string }>;
export const RESOURCE: string;
export function parseArgs(args: string[]): Options;
export function planUpdate(service: unknown): {
  name: string;
  etag: string;
  template: { containers: Container[] };
} | null;
export function imageDigest(revision: unknown, revisionName: string): string;
export function saveSnapshot(directory: string, snapshot: Snapshot): string;
export function run(options: Options, dependencies: {
  request: Request;
  saveSnapshot?: (directory: string, snapshot: Snapshot) => string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}): Promise<{ status: string; [key: string]: unknown }>;
export function waitOperation(operation: unknown, request: Request, polling: {
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  timeoutMs: number;
}): Promise<void>;
