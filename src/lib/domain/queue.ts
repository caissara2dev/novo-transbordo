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
  closedAtIso?: string | null;
  documentExpiresAtIso?: string | null;
  documentRetentionReviewRequired?: boolean;
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
      shared: SharedFields;
    }
  | { kind: "ISSUE_ADD"; issue: { id: string; description: string } }
  | { kind: "ISSUE_SET_STATE"; issueId: string; resolved: boolean }
  | { kind: "ISSUE_DELETE"; issueId: string }
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

export const sharedFieldLimits = { booking: 100, sample: 100, observation: 300 } as const;
export function assertSharedFieldLimits(before: SharedFields, after: SharedFields) {
  const names = { booking: "Booking", sample: "Amostra", observation: "Observação" };
  for (const field of Object.keys(sharedFieldLimits) as (keyof SharedFields)[]) {
    if (after[field] !== before[field] && after[field].length > sharedFieldLimits[field])
      throw new Error(`${names[field]} deve ter até ${sharedFieldLimits[field]} caracteres. O valor anterior foi mantido.`);
  }
}
export function queueMatchesSearch(visit: QueueVisit, query: string) {
  const search = query.trim().toLocaleLowerCase("pt-BR");
  const text = [visit.plate, visit.driverName, visit.publicCode, visit.booking, visit.clientName, visit.product]
    .join(" ").toLocaleLowerCase("pt-BR");
  const plateQuery = search.replace(/[-\s]/g, "");
  const plate = visit.plate.replace(/[-\s]/g, "").toLocaleLowerCase("pt-BR");
  return text.includes(search) || Boolean(plateQuery && plate.includes(plateQuery));
}
export function queueIssueAction(command: QueueCommand) {
  if (command.kind === "ISSUE_ADD") return "Pendência adicionada";
  if (command.kind === "ISSUE_DELETE") return "Pendência excluída";
  if (command.kind === "ISSUE_SET_STATE") return command.resolved ? "Pendência resolvida" : "Pendência reaberta";
  return null;
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
  if (command.kind === "SHARED" || command.kind === "CLASSIFY") assertSharedFieldLimits(visit, command.shared);
  if (command.kind === "ISSUE_ADD") {
    const issues = visit.issues ?? [];
    if (issues.length >= 50) throw new Error("Esta visita já tem 50 pendências registradas.");
    if (issues.some((issue) => issue.id === command.issue.id)) throw new Error("Esta pendência já foi registrada. Atualize a visita.");
    const description = command.issue.description.trim();
    if (!description || description.length > 500) throw new Error("Descreva a pendência em até 500 caracteres.");
    return { ...visit, issues: [...issues, { ...command.issue, description, resolved: false }] };
  }
  if (command.kind === "ISSUE_SET_STATE" || command.kind === "ISSUE_DELETE") {
    const issues = visit.issues ?? [];
    if (!issues.some((issue) => issue.id === command.issueId)) throw new Error("Pendência não encontrada. Atualize a visita.");
    return { ...visit, issues: command.kind === "ISSUE_DELETE"
      ? issues.filter((issue) => issue.id !== command.issueId)
      : issues.map((issue) => issue.id === command.issueId ? { ...issue, resolved: command.resolved } : issue) };
  }
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
