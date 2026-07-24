import { DateTime } from "luxon";
import { adminDb } from "@/lib/firebase/admin";
import { currentShiftFromNow } from "@/lib/domain/time";
import { TZ } from "@/lib/domain/constants";
import { eventContainerStatus, OPEN_CONTAINER_STATUSES } from "@/lib/server/container-states";
import { DisplayClientCount, DisplayOverviewResponse } from "@/types/api";
import { ContainerStatus } from "@/types/domain";

type DisplayEventSource = {
  category?: unknown;
  productive?: unknown;
  deleted?: unknown;
  durationMinutes?: unknown;
  clientId?: unknown;
  clientNameSnapshot?: unknown;
  container?: unknown;
  containerStatus?: unknown;
};

type DisplayContainerSource = {
  status?: unknown;
  clientId?: unknown;
  clientNameSnapshot?: unknown;
};

function clientKey(clientId: unknown, clientName: unknown): string {
  const id = typeof clientId === "string" ? clientId.trim() : "";
  if (id) return id;

  const name = typeof clientName === "string" ? clientName.trim() : "";
  return name ? `legacy:${name.toLocaleUpperCase("pt-BR")}` : "unknown";
}

function clientLabel(clientName: unknown): string {
  if (typeof clientName !== "string") return "Cliente não identificado";
  return clientName.trim() || "Cliente não identificado";
}

export function buildDisplayOverview(params: {
  operationalDate: string;
  generatedAt: string;
  events: DisplayEventSource[];
  containerStates: DisplayContainerSource[];
}): DisplayOverviewResponse {
  const clients = new Map<string, DisplayClientCount>();
  const productiveDurations: number[] = [];
  let finalizedTotal = 0;

  const getClient = (clientId: unknown, clientName: unknown): DisplayClientCount => {
    const key = clientKey(clientId, clientName);
    const existing = clients.get(key);
    if (existing) {
      if (
        existing.clientName === "Cliente não identificado" &&
        clientLabel(clientName) !== "Cliente não identificado"
      ) {
        existing.clientName = clientLabel(clientName);
      }
      return existing;
    }

    const entry: DisplayClientCount = {
      clientId: key,
      clientName: clientLabel(clientName),
      finalizedToday: 0,
      openNow: 0
    };
    clients.set(key, entry);
    return entry;
  };

  for (const event of params.events) {
    if (event.deleted === true) continue;

    const productive = event.productive === true || event.category === "PRODUTIVO";
    if (!productive) continue;

    const duration = Number(event.durationMinutes);
    if (Number.isFinite(duration) && duration >= 0) {
      productiveDurations.push(duration);
    }

    const status = eventContainerStatus(event);
    if (status !== "FULL" && status !== "BLEND_FULL") continue;

    finalizedTotal += 1;
    getClient(event.clientId, event.clientNameSnapshot).finalizedToday += 1;
  }

  const openContainers = {
    total: 0,
    partial: 0,
    buffer: 0,
    blendPartial: 0
  };

  for (const state of params.containerStates) {
    const status = state.status as ContainerStatus;
    if (!OPEN_CONTAINER_STATUSES.includes(status)) continue;

    openContainers.total += 1;
    if (status === "PARTIAL") openContainers.partial += 1;
    if (status === "BUFFER") openContainers.buffer += 1;
    if (status === "BLEND_PARTIAL") openContainers.blendPartial += 1;
    getClient(state.clientId, state.clientNameSnapshot).openNow += 1;
  }

  const averageProductiveMinutes = productiveDurations.length
    ? productiveDurations.reduce((total, duration) => total + duration, 0) /
      productiveDurations.length
    : null;

  return {
    operationalDate: params.operationalDate,
    generatedAt: params.generatedAt,
    finalizedTotal,
    averageProductiveMinutes,
    openContainers,
    clients: [...clients.values()]
      .filter((client) => client.finalizedToday > 0 || client.openNow > 0)
      .sort(
        (a, b) =>
          b.finalizedToday - a.finalizedToday ||
          b.openNow - a.openNow ||
          a.clientName.localeCompare(b.clientName, "pt-BR", { sensitivity: "base" })
      )
  };
}

export async function getDisplayOverview(
  now = DateTime.now().setZone(TZ)
): Promise<DisplayOverviewResponse> {
  const { shiftDate } = currentShiftFromNow(now);
  const [eventsSnapshot, containersSnapshot] = await Promise.all([
    adminDb
      .collection("events")
      .where("deleted", "==", false)
      .where("shiftDate", "==", shiftDate)
      .get(),
    adminDb
      .collection("containerStates")
      .where("status", "in", OPEN_CONTAINER_STATUSES)
      .get()
  ]);

  return buildDisplayOverview({
    operationalDate: shiftDate,
    generatedAt: now.toUTC().toISO() ?? new Date().toISOString(),
    events: eventsSnapshot.docs.map((doc) => doc.data()),
    containerStates: containersSnapshot.docs.map((doc) => doc.data())
  });
}
