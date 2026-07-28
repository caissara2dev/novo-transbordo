import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  findMissingEventHistoryIndexes
} from "../../scripts/lib/firestore-index-policy.mjs";

type FirestoreIndexManifest = {
  indexes: Array<{
    collectionGroup: string;
    queryScope: string;
    fields: Array<{
      fieldPath: string;
      order: string;
    }>;
  }>;
};

function readManifest(): FirestoreIndexManifest {
  return JSON.parse(
    readFileSync("firestore.indexes.json", "utf8")
  ) as FirestoreIndexManifest;
}

describe("política de índices do histórico", () => {
  it("mantém as sete combinações exigidas pela paginação", () => {
    expect(findMissingEventHistoryIndexes(readManifest())).toEqual([]);
  });

  it("bloqueia a verificação quando um índice obrigatório é removido", () => {
    const manifest = readManifest();
    const withoutAdminActiveHistory = {
      ...manifest,
      indexes: manifest.indexes.filter(
        (index) =>
          !(
            index.collectionGroup === "events" &&
            index.fields.length === 2 &&
            index.fields[0]?.fieldPath === "deleted" &&
            index.fields[1]?.fieldPath === "startAt"
          )
      )
    };

    expect(
      findMissingEventHistoryIndexes(withoutAdminActiveHistory)
    ).toEqual(["deleted:ASCENDING|startAt:DESCENDING"]);
  });
});
