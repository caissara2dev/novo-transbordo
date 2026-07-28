import {
  FieldPath,
  Timestamp
} from "firebase-admin/firestore";
import { matchesOperationalHistory } from "@/lib/domain/event-order";
import { adminDb } from "@/lib/firebase/admin";
import { eventContainerStatus } from "@/lib/server/container-states";
import { EventFilters } from "@/lib/server/filters";
import {
  decodePaginationCursor,
  encodePaginationCursor,
  paginationScope,
  PaginationInput,
  scanFilteredPage
} from "@/lib/server/pagination";
import { EventDoc, UserDoc } from "@/types/domain";

type EventListPosition = {
  shiftDate: string | null;
  startAt: Timestamp;
  documentId: string;
};

function eventListPosition(
  doc: FirebaseFirestore.QueryDocumentSnapshot,
  dateOrdered: boolean
): EventListPosition {
  const data = doc.data() as EventDoc;
  return {
    shiftDate: dateOrdered ? data.shiftDate : null,
    startAt: data.startAt as Timestamp,
    documentId: doc.id
  };
}

function eventListItem(doc: FirebaseFirestore.QueryDocumentSnapshot) {
  const data = doc.data() as EventDoc;
  return {
    id: doc.id,
    ...data,
    startAt: data.startAt as Timestamp,
    endAt: data.endAt as Timestamp,
    createdAt: data.createdAt as Timestamp,
    containerStatus: eventContainerStatus(data),
    containerReason: data.containerReason || null,
    containerCycleId: data.containerCycleId || null,
    previousContainerEventId: data.previousContainerEventId || null,
    containerStateVersion: data.containerStateVersion ?? null,
    origin: data.origin || "MANUAL",
    generatedForEventId: data.generatedForEventId || null,
    gapSegmentId: data.gapSegmentId || null,
    justificationWaived: Boolean(data.justificationWaived),
    startsNewContainerCycle: Boolean(data.startsNewContainerCycle),
    blendConfirmed: Boolean(data.blendConfirmed)
  };
}

export async function listEvents(params: {
  role: UserDoc["role"];
  uid: string;
  filters: EventFilters;
  pagination: PaginationInput;
}) {
  const { role, uid, filters, pagination } = params;
  const dateOrdered = Boolean(filters.dateFrom || filters.dateTo);
  const scope = paginationScope("events", [
    role,
    role === "OPERATOR" ? uid : null,
    filters.dateFrom || null,
    filters.dateTo || null,
    filters.pump || null,
    filters.shiftType || null,
    filters.category || null,
    filters.clientId || null,
    filters.containerStatus || null,
    Boolean(filters.includeDeleted)
  ]);

  let query = adminDb.collection("events") as FirebaseFirestore.Query;

  if (role === "OPERATOR") {
    query = query.where("createdByUid", "==", uid);
  }

  if (!filters.includeDeleted) {
    query = query.where("deleted", "==", false);
  }

  if (filters.dateFrom) {
    query = query.where("shiftDate", ">=", filters.dateFrom);
  }

  if (filters.dateTo) {
    query = query.where("shiftDate", "<=", filters.dateTo);
  }

  if (dateOrdered) {
    query = query
      .orderBy("shiftDate", "desc")
      .orderBy("startAt", "desc");
  } else {
    query = query.orderBy("startAt", "desc");
  }
  query = query.orderBy(FieldPath.documentId(), "desc");

  const decodedCursor = pagination.cursor
    ? decodePaginationCursor({
        cursor: pagination.cursor,
        kind: "events",
        scope,
        valueTypes: dateOrdered
          ? ["string", "timestamp-millis"]
          : ["timestamp-millis"]
      })
    : null;
  const initialPosition: EventListPosition | null = decodedCursor
    ? dateOrdered
      ? {
          shiftDate: String(decodedCursor.values[0]),
          startAt: Timestamp.fromMillis(Number(decodedCursor.values[1])),
          documentId: decodedCursor.documentId
        }
      : {
          shiftDate: null,
          startAt: Timestamp.fromMillis(Number(decodedCursor.values[0])),
          documentId: decodedCursor.documentId
        }
    : null;
  const scanBatchSize = Math.min(Math.max(pagination.limit * 2, 50), 200);
  const scan = await scanFilteredPage({
    limit: pagination.limit,
    batchSize: scanBatchSize,
    initialPosition,
    fetchPage: async (after, limit) => {
      const cursorValues = after
        ? dateOrdered
          ? [after.shiftDate, after.startAt, after.documentId]
          : [after.startAt, after.documentId]
        : null;
      const pageQuery = cursorValues
        ? query.startAfter(...cursorValues)
        : query;
      const snap = await pageQuery.limit(limit).get();
      return snap.docs;
    },
    positionForDocument: (doc) =>
      eventListPosition(doc, dateOrdered),
    matchDocument: (doc) => {
      const event = eventListItem(doc);
      if (!matchesOperationalHistory(event, { role, uid, filters })) {
        return undefined;
      }
      return {
        position: eventListPosition(doc, dateOrdered),
        event
      };
    }
  });
  const pageEntries = scan.matches.slice(0, pagination.limit);
  const visibleEvents = pageEntries.map((entry) => entry.event);
  const lastReturned = pageEntries.at(-1);
  const nextPosition = scan.incomplete
    ? scan.lastScannedPosition
    : scan.matches.length > pagination.limit
      ? lastReturned?.position || null
      : null;
  const nextCursor = nextPosition
    ? encodePaginationCursor({
        kind: "events",
        scope,
        values: dateOrdered
          ? [
              nextPosition.shiftDate || "",
              nextPosition.startAt.toMillis()
            ]
          : [nextPosition.startAt.toMillis()],
        documentId: nextPosition.documentId
      })
    : null;

  return {
    items: visibleEvents.map((event) => ({
      ...event,
      previousContainerPassages: []
    })),
    nextCursor,
    incomplete: scan.incomplete
  };
}
