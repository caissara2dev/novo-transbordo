const REQUIRED_EVENT_HISTORY_INDEXES = [
  [
    ["deleted", "ASCENDING"],
    ["startAt", "DESCENDING"]
  ],
  [
    ["createdByUid", "ASCENDING"],
    ["startAt", "DESCENDING"]
  ],
  [
    ["createdByUid", "ASCENDING"],
    ["deleted", "ASCENDING"],
    ["startAt", "DESCENDING"]
  ],
  [
    ["shiftDate", "DESCENDING"],
    ["startAt", "DESCENDING"]
  ],
  [
    ["deleted", "ASCENDING"],
    ["shiftDate", "DESCENDING"],
    ["startAt", "DESCENDING"]
  ],
  [
    ["createdByUid", "ASCENDING"],
    ["shiftDate", "DESCENDING"],
    ["startAt", "DESCENDING"]
  ],
  [
    ["createdByUid", "ASCENDING"],
    ["deleted", "ASCENDING"],
    ["shiftDate", "DESCENDING"],
    ["startAt", "DESCENDING"]
  ]
];

function fieldSignature(fields) {
  return fields
    .map(([fieldPath, order]) => `${fieldPath}:${order}`)
    .join("|");
}

const REQUIRED_EVENT_HISTORY_SIGNATURES =
  REQUIRED_EVENT_HISTORY_INDEXES.map(fieldSignature);

function manifestIndexSignature(index) {
  if (
    !index ||
    index.collectionGroup !== "events" ||
    index.queryScope !== "COLLECTION" ||
    !Array.isArray(index.fields)
  ) {
    return null;
  }

  const fields = index.fields.map((field) => [
    field?.fieldPath,
    field?.order
  ]);

  if (
    fields.some(
      ([fieldPath, order]) =>
        typeof fieldPath !== "string" ||
        typeof order !== "string"
    )
  ) {
    return null;
  }

  return fieldSignature(fields);
}

export function findMissingEventHistoryIndexes(manifest) {
  const indexes = Array.isArray(manifest?.indexes)
    ? manifest.indexes
    : [];
  const available = new Set(
    indexes
      .map(manifestIndexSignature)
      .filter((signature) => signature !== null)
  );

  return REQUIRED_EVENT_HISTORY_SIGNATURES.filter(
    (signature) => !available.has(signature)
  );
}
