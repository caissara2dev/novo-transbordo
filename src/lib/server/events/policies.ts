import { Timestamp } from "firebase-admin/firestore";
import { categoryRules } from "@/lib/domain/constants";
import { HttpError } from "@/lib/domain/errors";
import { resolveTimelineDate } from "@/lib/domain/time";
import { adminDb } from "@/lib/firebase/admin";
import { previewEventGap } from "@/lib/server/gaps";
import {
  Category,
  EventDoc,
  EventInput,
  GapJustification,
  GapSegment
} from "@/types/domain";

export async function assertClientIfRequired(
  clientId: string | null
): Promise<string | null> {
  if (!clientId) {
    return null;
  }

  const clientRef = adminDb.collection("clients").doc(clientId);
  const snap = await clientRef.get();

  if (!snap.exists) {
    throw new HttpError(400, "Cliente informado não existe.");
  }

  const client = snap.data() as { active: boolean; name: string };

  if (!client.active) {
    throw new HttpError(400, "Cliente informado está inativo.");
  }

  return client.name;
}

export async function assertNoOverlap(params: {
  pump: EventDoc["pump"];
  startAt: Timestamp;
  endAt: Timestamp;
  ignoreEventId?: string;
  ignoreEventIds?: string[];
}): Promise<void> {
  const snap = await adminDb
    .collection("events")
    .where("pump", "==", params.pump)
    .where("deleted", "==", false)
    .where("startAt", "<", params.endAt)
    .get();

  const hasOverlap = snap.docs.some((doc) => {
    if (params.ignoreEventId && doc.id === params.ignoreEventId) {
      return false;
    }
    if (params.ignoreEventIds?.includes(doc.id)) return false;

    const data = doc.data() as EventDoc;
    if (
      params.ignoreEventId &&
      data.generatedForEventId === params.ignoreEventId
    ) {
      return false;
    }
    const existingStart = data.startAt as Timestamp;
    const existingEnd = data.endAt as Timestamp;

    return (
      existingStart.toMillis() < params.endAt.toMillis() &&
      existingEnd.toMillis() > params.startAt.toMillis()
    );
  });

  if (hasOverlap) {
    throw new HttpError(
      409,
      "Existe sobreposição de horário em lançamentos desta bomba."
    );
  }
}

const justifiableCategories: Array<
  Exclude<Category, "PRODUTIVO" | "INTERVALO_OPERACIONAL">
> = [
  "EM_TRANSITO",
  "AGUARDANDO_LABORATORIO",
  "SEM_CAMINHAO",
  "SEM_CONTAINER",
  "MANUTENCAO",
  "OUTROS"
];

function parseGapJustification(
  raw: unknown,
  expected: GapSegment
): GapJustification {
  if (!raw || typeof raw !== "object") {
    throw new HttpError(
      400,
      `Justifique o trecho ${expected.startTime}–${expected.endTime}.`
    );
  }
  const input = raw as Partial<GapJustification>;
  if (
    input.id !== expected.id ||
    input.startTime !== expected.startTime ||
    input.endTime !== expected.endTime ||
    input.durationMinutes !== expected.durationMinutes ||
    !justifiableCategories.includes(input.category as never)
  ) {
    throw new HttpError(
      400,
      "Uma justificativa de intervalo está inválida ou desatualizada."
    );
  }
  const category = input.category as GapJustification["category"];
  const rules = categoryRules[category];
  const clientId = input.clientId?.trim() || null;
  const plate = input.plate?.trim().toUpperCase() || null;
  const notes = input.notes?.trim() || null;
  if (rules.requiresClient && !clientId) {
    throw new HttpError(
      400,
      `Cliente obrigatório no trecho ${expected.startTime}–${expected.endTime}.`
    );
  }
  if (rules.requiresPlate && !plate) {
    throw new HttpError(
      400,
      `Placa obrigatória no trecho ${expected.startTime}–${expected.endTime}.`
    );
  }
  if (rules.requiresNotes && !notes) {
    throw new HttpError(
      400,
      `Observação obrigatória no trecho ${expected.startTime}–${expected.endTime}.`
    );
  }
  return { ...expected, category, clientId, plate, notes };
}

type AutomaticGapEvent = Omit<
  EventDoc,
  "containerCycleId" | "previousContainerEventId" | "containerStateVersion"
>;

export async function buildAutomaticGapEvents(params: {
  preview: Awaited<ReturnType<typeof previewEventGap>>;
  rawJustifications: unknown[] | undefined;
  productiveEvent: Pick<EventInput, "pump" | "shiftDate" | "shiftType">;
  actor: { uid: string; email: string };
  createdAt: Timestamp;
  reconciledAfterEventId?: string | null;
}): Promise<AutomaticGapEvent[]> {
  const supplied = Array.isArray(params.rawJustifications)
    ? params.rawJustifications
    : [];
  if (
    params.preview.requiresJustification &&
    supplied.length !== params.preview.uncoveredSegments.length
  ) {
    throw new HttpError(
      400,
      "Informe uma causa para cada trecho de ociosidade."
    );
  }

  return Promise.all(
    params.preview.uncoveredSegments.map(async (segment, index) => {
      const justification = params.preview.requiresJustification
        ? parseGapJustification(supplied[index], segment)
        : null;
      const category = justification?.category || "INTERVALO_OPERACIONAL";
      const clientNameSnapshot = await assertClientIfRequired(
        justification?.clientId || null
      );
      const startAt = Timestamp.fromDate(
        resolveTimelineDate(
          params.productiveEvent.shiftDate,
          params.productiveEvent.shiftType,
          segment.startTime
        ).toJSDate()
      );
      const endAt = Timestamp.fromDate(
        resolveTimelineDate(
          params.productiveEvent.shiftDate,
          params.productiveEvent.shiftType,
          segment.endTime
        ).toJSDate()
      );

      return {
        pump: params.productiveEvent.pump,
        shiftDate: params.productiveEvent.shiftDate,
        shiftType: params.productiveEvent.shiftType,
        startTime: segment.startTime,
        endTime: segment.endTime,
        category,
        clientId: justification?.clientId || null,
        plate: justification?.plate || null,
        container: null,
        containerStatus: null,
        containerReason: null,
        startsNewContainerCycle: false,
        blendConfirmed: false,
        notes: justification?.notes || null,
        productive: false,
        origin: "AUTO_GAP",
        generatedForEventId: null,
        gapSegmentId: segment.id,
        justificationWaived: !params.preview.requiresJustification,
        reconciledAfterEventId: params.reconciledAfterEventId || null,
        clientNameSnapshot,
        startAt,
        endAt,
        durationMinutes: segment.durationMinutes,
        createdByUid: params.actor.uid,
        createdByEmail: params.actor.email,
        updatedByUid: params.actor.uid,
        updatedByEmail: params.actor.email,
        createdAt: params.createdAt,
        updatedAt: params.createdAt,
        deleted: false,
        deletedAt: null,
        deletedByUid: null,
        deletedByEmail: null,
        deletedReason: null
      };
    })
  );
}
