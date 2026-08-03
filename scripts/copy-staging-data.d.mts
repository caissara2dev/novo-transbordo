export const EXPECTED_SOURCE_PROJECT: string;
export const EXPECTED_TARGET_PROJECT: string;
export const STAGING_RETENTION_DAYS: number;

export type CopyOptions = {
  help: boolean;
  execute: boolean;
  dryRun: boolean;
  confirmation: string | null;
};

export function parseArgs(argv: string[]): CopyOptions;
export function validateProjects(
  sourceProject: string,
  targetProject: string,
  options: CopyOptions
): void;
export function anonymizeDocumentId(
  collection: "clients" | "events" | "revisions",
  documentId: string,
  secret: string
): string;
export function anonymizeDocument<TExpiresAt>(options: {
  collection: "clients" | "events" | "revisions";
  documentId: string;
  data: Record<string, unknown>;
  secret: string;
  expiresAt: TExpiresAt;
}): Record<string, unknown> & { expiresAt: TExpiresAt };
export function main(argv?: string[]): Promise<void>;
