export const PRODUCTION_PROJECT_ID: string;
export const PRODUCTION_CONFIRMATION: string;

export type PromotionOptions = {
  help: boolean;
  uid: string | null;
  projectId: string | null;
  execute: boolean;
  dryRun: boolean;
  confirmation: string | null;
  allowProduction: boolean;
  productionConfirmation: string | null;
};

export function parseArgs(argv: string[]): PromotionOptions;
export function validatePromotionRequest(options: PromotionOptions): void;
export function buildPromotionPatch(nowIso: string): {
  role: "ADMIN";
  approved: true;
  approvedAt: string;
  updatedAt: string;
};
export function main(argv?: string[]): Promise<void>;
