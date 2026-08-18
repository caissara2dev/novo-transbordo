export const PRODUCTION_BACKFILL_CONFIRMATION: string;

export type BackfillOptions = {
  help: boolean;
  execute: boolean;
  dryRun: boolean;
  projectId: string;
  confirmation: string | null;
  allowProduction: boolean;
  productionConfirmation: string | null;
};

export function parseArgs(argv: string[]): BackfillOptions;
export function validateBackfillRequest(options: BackfillOptions): void;

export function buildContainerStateBackfillCandidates(events: Array<{
  id: string;
  data: Record<string, unknown>;
}>): Map<string, {
  id: string;
  key: string;
  status: string;
  data: Record<string, unknown>;
}>;

export function buildContainerStateBackfillPatch(params: {
  existing: Record<string, unknown> | undefined;
  eventId: string;
  key: string;
  status: string;
  data: Record<string, unknown>;
}): (Record<string, unknown> & { version: number }) | null;

export function main(argv?: string[]): Promise<void>;
