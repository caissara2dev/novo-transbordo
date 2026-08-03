export type FirestoreIndexManifest = {
  indexes?: Array<{
    collectionGroup?: unknown;
    queryScope?: unknown;
    fields?: Array<{
      fieldPath?: unknown;
      order?: unknown;
    }>;
  }>;
};

export function findMissingEventHistoryIndexes(
  manifest: FirestoreIndexManifest
): string[];
