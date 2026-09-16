import type { CheckinStatus, DriverCheckinForm } from "./checkins";

export type QueueClient = {
  id: string;
  name: string;
  portalEnabled: boolean;
  usesSample: boolean;
};
export type QueueIssue = { id: string; description: string; resolved: boolean };
export type QueueRevision = {
  id: string;
  action: string;
  actor: string;
  at: string;
  fields: string[];
};
export type QueueVisit = {
  document?: import("./checkin-document").VisitDocument;
  id: string;
  publicCode: string;
  plate: string;
  driverName: string;
  carrierName: string;
  product: string;
  originPlant: string;
  originInvoiceNumbers: string;
  remittanceInvoiceNumber: string;
  vehicleType: DriverCheckinForm["vehicleType"];
  clientId: string | null;
  clientName: string | null;
  status: CheckinStatus;
  version: number;
  booking: string;
  sample: string;
  observation: string;
  usesSample: boolean;
  confirmedAtIso: string | null;
  updatedAtIso: string;
  updatedBy: string;
  issues?: QueueIssue[];
  revisions?: QueueRevision[];
  driverLicense?: string;
  driverPhone?: string;
  location?: {
    latitude: number;
    longitude: number;
    accuracyMeters: number;
    capturedAtIso: string;
  } | null;
};
export type SharedFields = Pick<
  QueueVisit,
  "booking" | "sample" | "observation"
>;
export type QueueCommand =
  | {
      kind: "CLASSIFY";
      clientId: string;
      issues: QueueIssue[];
      shared: SharedFields;
    }
  | { kind: "SHARED"; shared: SharedFields }
  | { kind: "TRANSITION"; toStatus: CheckinStatus }
  | { kind: "CORRECT"; patch: Partial<DriverCheckinForm>; reason: string };
export const queueLabels: Record<CheckinStatus, string> = {
  PRE_CADASTRO: "Pré-cadastro",
  AGUARDANDO_LIBERACAO: "Aguardando liberação",
  AGUARDANDO_CHAMADA: "Aguardando chamada",
  CHAMADO: "Chamado",
  EM_DESCARGA: "Em descarga",
  CONCLUIDO: "Concluído",
  CANCELADO: "Cancelado",
};
export function closedVisit(status: CheckinStatus) {
  return status === "CONCLUIDO" || status === "CANCELADO";
}
export function publicCustomerVisit(visit: QueueVisit): QueueVisit {
  const {
    id,
    publicCode,
    plate,
    driverName,
    carrierName,
    product,
    originPlant,
    originInvoiceNumbers,
    remittanceInvoiceNumber,
    vehicleType,
    clientId,
    clientName,
    status,
    version,
    booking,
    sample,
    observation,
    usesSample,
    confirmedAtIso,
    updatedAtIso,
    updatedBy,
  } = visit;
  return {
    id,
    publicCode,
    plate,
    driverName,
    carrierName,
    product,
    originPlant,
    originInvoiceNumbers,
    remittanceInvoiceNumber,
    vehicleType,
    clientId,
    clientName,
    status,
    version,
    booking,
    sample,
    observation,
    usesSample,
    confirmedAtIso,
    updatedAtIso,
    updatedBy,
  };
}
export function queueCsv(visits: QueueVisit[]) {
  const cell = (value: unknown) => {
    const text = String(value ?? "");
    return (
      '"' +
      (/^[\s]*[=+@-]/.test(text) ? "'" : "") +
      text.replaceAll('"', '""') +
      '"'
    );
  };
  const rows = [
    [
      "Código",
      "Check-in",
      "Placa",
      "Motorista",
      "Transportadora",
      "Produto",
      "Usina",
      "NF usina",
      "NF remessa",
      "Cliente",
      "Booking",
      "Amostra",
      "Observação",
      "Status",
    ],
    ...visits.map((v) => [
      v.publicCode,
      v.confirmedAtIso,
      v.plate,
      v.driverName,
      v.carrierName,
      v.product,
      v.originPlant,
      v.originInvoiceNumbers,
      v.remittanceInvoiceNumber,
      v.clientName,
      v.booking,
      v.sample,
      v.observation,
      queueLabels[v.status],
    ]),
  ];
  return "\uFEFF" + rows.map((row) => row.map(cell).join(";")).join("\r\n");
}

export function applyQueueCommand(
  visit: QueueVisit,
  command: QueueCommand,
  clients: QueueClient[],
  customer?: QueueClient,
): QueueVisit {
  if (
    customer &&
    (visit.clientId !== customer.id ||
      !customer.portalEnabled ||
      closedVisit(visit.status) ||
      command.kind !== "SHARED")
  )
    throw new Error("Esta conta não pode alterar esta visita.");
  if (command.kind === "SHARED")
    return {
      ...visit,
      ...command.shared,
      sample:
        customer && !customer.usesSample ? visit.sample : command.shared.sample,
    };
  if (command.kind === "CLASSIFY") {
    const client = clients.find((c) => c.id === command.clientId);
    if (!client && command.clientId)
      throw new Error("Selecione um cliente ativo.");
    const reassigned = Boolean(
      visit.clientId && visit.clientId !== command.clientId,
    );
    if (
      visit.clientId !== command.clientId &&
      visit.status !== "AGUARDANDO_LIBERACAO"
    )
      throw new Error(
        "Atribua o cliente durante a análise, antes da liberação.",
      );
    return {
      ...visit,
      ...command.shared,
      ...(reassigned ? { booking: "", sample: "", observation: "" } : {}),
      issues: command.issues,
      clientId: client?.id ?? null,
      clientName: client?.name ?? null,
      usesSample: client?.usesSample ?? true,
    };
  }
  if (command.kind === "TRANSITION") {
    const allowed: Partial<Record<CheckinStatus, CheckinStatus>> = {
      AGUARDANDO_LIBERACAO: "AGUARDANDO_CHAMADA",
      AGUARDANDO_CHAMADA: "CHAMADO",
      EM_DESCARGA: "CONCLUIDO",
    };
    if (allowed[visit.status] !== command.toStatus)
      throw new Error(
        "Transição não permitida. A descarga exige um lançamento vinculado.",
      );
    if (
      command.toStatus !== "CONCLUIDO" &&
      (!visit.clientId || visit.issues?.some((i) => !i.resolved))
    )
      throw new Error(
        "Atribua um cliente e resolva as pendências antes de liberar ou chamar.",
      );
    return { ...visit, status: command.toStatus };
  }
  return { ...visit, ...command.patch };
}
