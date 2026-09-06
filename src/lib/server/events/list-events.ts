import { FieldPath, Timestamp } from "firebase-admin/firestore";
import {
  collectPreviousContainerPassages,
  ContainerCycleHistoryEntry
} from "@/lib/domain/container-cycle-history";
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

import { readContainerPassage } from "@/lib/server/container-history";

const MAX_PREVIOUS_CONTAINER_PASSAGES = 20;

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
    blendConfirmed: Boolean(data.blendConfirmed),
    loadSourceType:
      (data.productive ?? data.category === "PRODUTIVO")
        ? data.loadSourceType || "TRUCK"
        : null,
    sourceContainer: data.sourceContainer || null,
    sourceContainerEmptied:
      data.loadSourceType === "BUFFER_CONTAINER"
        ? data.sourceContainerEmptied ?? null
        : null,
    sourceContainerCycleId: data.sourceContainerCycleId || null,
    previousSourceContainerEventId: data.previousSourceContainerEventId || null,
    sourceContainerStateVersion: data.sourceContainerStateVersion ?? null
  };
}

type EventListItem = ReturnType<typeof eventListItem>;

function canReadContainerPassage(
  data: Pick<EventDoc, "createdByUid">,
  role: UserDoc["role"],
  uid: string
) {
  return role !== "OPERATOR" || data.createdByUid === uid;
}

function containerHistoryEntry(
  id: string,
  data: EventListItem | EventDoc
): ContainerCycleHistoryEntry | null {
  const status =
    "containerStatus" in data
      ? data.containerStatus
      : eventContainerStatus(data);
  if (!status) {
    return null;
  }

  return {
    id,
    containerCycleId: data.containerCycleId || null,
    previousContainerEventId: data.previousContainerEventId || null,
    startTime: data.startTime,
    endTime: data.endTime,
    pump: data.pump,
    plate: data.plate || null,
    status,
    role: "DESTINATION",
    relatedContainer: data.sourceContainer || null,
    deleted: Boolean(data.deleted)
  };
}

async function previousContainerPassagesForEvents(params: {
  events: EventListItem[];
  role: UserDoc["role"];
  uid: string;
}) {
  const documents = new Map<string, Promise<EventDoc | null>>();
  const passages = new Map<string, ReturnType<typeof readContainerPassage>>();
  const result = new Map<
    string,
    { passages: ReturnType<typeof collectPreviousContainerPassages>; incomplete: boolean }
  >();
  await Promise.all(params.events.map(async (event) => {
    const current = containerHistoryEntry(event.id, event);
    const history = new Map<string, ContainerCycleHistoryEntry>();
    let previousId = current?.previousContainerEventId;
    let incomplete = false;
    while (
      current &&
      event.container &&
      previousId &&
      history.size < MAX_PREVIOUS_CONTAINER_PASSAGES &&
      !history.has(previousId)
    ) {
      let pending = documents.get(previousId);
      if (!pending) {
        pending = adminDb
          .collection("events")
          .doc(previousId)
          .get()
          .then((doc) => (doc.exists ? (doc.data() as EventDoc) : null));
        documents.set(previousId, pending);
      }
      const data = await pending;
      if (!data || !canReadContainerPassage(data, params.role, params.uid))
        break;
      const key = `${event.container}:${previousId}`;
      let passage = passages.get(key);
      if (!passage) {
        passage = readContainerPassage(previousId, data, event.container);
        passages.set(key, passage);
      }
      const entry = await passage;
      if (!entry) {
        incomplete = true;
        break;
      }
      if (entry.containerCycleId !== current.containerCycleId) break;
      history.set(entry.id, {
        ...entry,
        role: entry.containerRole
      });
      previousId = entry.previousContainerEventId;
    }
    result.set(
      event.id,
      {
        passages: current ? collectPreviousContainerPassages(current, history) : [],
        incomplete
      }
    );
  }));
  return result;
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
    query = query.orderBy("shiftDate", "desc").orderBy("startAt", "desc");
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
    positionForDocument: (doc) => eventListPosition(doc, dateOrdered),
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
  const previousPassagesByEventId = await previousContainerPassagesForEvents({
    events: visibleEvents,
    role,
    uid
  });
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
          ? [nextPosition.shiftDate || "", nextPosition.startAt.toMillis()]
          : [nextPosition.startAt.toMillis()],
        documentId: nextPosition.documentId
      })
    : null;

  return {
    items: visibleEvents.map((event) => ({
      ...event,
      previousContainerPassages: previousPassagesByEventId.get(event.id)?.passages || [],
      ...(previousPassagesByEventId.get(event.id)?.incomplete
        ? { warnings: ["Algumas passagens anteriores não puderam ser resolvidas. Solicite a revisão da linha do tempo."] }
        : {})
    })),
    nextCursor,
    incomplete: scan.incomplete
  };
}
