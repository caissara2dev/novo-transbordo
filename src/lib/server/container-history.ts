import { FieldPath, Timestamp } from "firebase-admin/firestore";
import { effectForContainer } from "@/lib/domain/container-effects";
import { resolveTransferSourceStatus } from "@/lib/domain/container-transfer";
import { normalizeContainer } from "@/lib/domain/identifiers";
import { HttpError } from "@/lib/domain/errors";
import { adminDb } from "@/lib/firebase/admin";
import { EventDoc } from "@/types/domain";
import {
  decodePaginationCursor,
  encodePaginationCursor,
  paginationScope,
  PaginationInput
} from "./pagination";

function historyQuery(
  container: string,
  field: "container" | "sourceContainer"
) {
  return adminDb
    .collection("events")
    .where(field, "==", container)
    .where("deleted", "==", false)
    .orderBy("endAt", "desc")
    .orderBy("createdAt", "desc")
    .orderBy(FieldPath.documentId(), "desc");
}

// Read persisted cycle links, resolving SOURCE from its preceding destination.
// Consecutive non-emptying SOURCE passages preserve that destination's state.
// This context is internal; callers still apply their passage visibility rules.
export async function readContainerPassage(
  id: string,
  data: EventDoc,
  container: string
) {
  const effect = effectForContainer(id, data, container);
  if (!effect || data.deleted) return null;
  let status = effect.status;
  const source = effect.role === "SOURCE";
  if (source) {
    const anchorSnap = await historyQuery(container, "container")
      .startAfter(data.endAt, data.createdAt, id)
      .limit(1)
      .get();
    const anchorDoc = anchorSnap.docs[0];
    const anchor = anchorDoc
      ? effectForContainer(
          anchorDoc.id,
          anchorDoc.data() as EventDoc,
          container
        )
      : null;
    if (
      !anchor ||
      !effect.existingCycleId ||
      anchor.existingCycleId !== effect.existingCycleId
    ) {
      throw new HttpError(
        409,
        "Não foi possível resolver o ciclo da origem. Atualize o histórico ou solicite a revisão da linha do tempo."
      );
    }
    status = resolveTransferSourceStatus({
      previousStatus: anchor.status,
      previousClientId: anchor.clientId,
      clientId: effect.clientId,
      emptied: Boolean(data.sourceContainerEmptied)
    });
  }
  return {
    ...data,
    id,
    status,
    containerCycleId: effect.existingCycleId,
    previousContainerEventId: source
      ? data.previousSourceContainerEventId || null
      : data.previousContainerEventId || null,
    containerRole: effect.role,
    relatedContainer: effect.relatedContainer
  };
}

export async function getContainerHistory(
  rawContainer: string,
  pagination: PaginationInput = { limit: 50 }
) {
  const container = normalizeContainer(rawContainer);
  if (!container) throw new HttpError(400, "Container inválido.");
  const scope = paginationScope("container-history", [container]);
  const cursor = pagination.cursor
    ? decodePaginationCursor({
        cursor: pagination.cursor,
        kind: "container-history",
        scope,
        valueTypes: ["timestamp-millis", "timestamp-millis"]
      })
    : null;
  const snapshots = await Promise.all(
    (["container", "sourceContainer"] as const).map(async (field) => {
      let query = historyQuery(container, field);
      if (cursor)
        query = query.startAfter(
          Timestamp.fromMillis(Number(cursor.values[0])),
          Timestamp.fromMillis(Number(cursor.values[1])),
          cursor.documentId
        );
      return query.limit(pagination.limit + 1).get();
    })
  );
  const docs = Array.from(
    new Map(
      snapshots.flatMap((snapshot) => snapshot.docs).map((doc) => [doc.id, doc])
    ).values()
  ).sort((a, b) => {
    const left = a.data() as EventDoc & {
      endAt: Timestamp;
      createdAt: Timestamp;
    };
    const right = b.data() as EventDoc & {
      endAt: Timestamp;
      createdAt: Timestamp;
    };
    return (
      right.endAt.toMillis() - left.endAt.toMillis() ||
      right.createdAt.toMillis() - left.createdAt.toMillis() ||
      (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
    );
  });
  const page = docs.slice(0, pagination.limit);
  const items = (
    await Promise.all(
      page.map((doc) =>
        readContainerPassage(doc.id, doc.data() as EventDoc, container)
      )
    )
  ).filter((item) => item !== null);
  const last = page.at(-1);
  return {
    items,
    nextCursor:
      docs.length > pagination.limit && last
        ? encodePaginationCursor({
            kind: "container-history",
            scope,
            values: [
              last.data().endAt.toMillis(),
              last.data().createdAt.toMillis()
            ],
            documentId: last.id
          })
        : null,
    incomplete: false
  };
}
