import "server-only";
import { z } from "zod";
import { FieldPath } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { HttpError } from "@/lib/domain/errors";
import {
  applyQueueCommand,
  publicCustomerVisit,
  closedVisit,
} from "@/lib/domain/queue";
import type {
  QueueClient,
  QueueVisit,
  QueueRevision,
} from "@/lib/domain/queue";
import type { StoredCheckin } from "@/types/checkins";
import type { UserDoc } from "@/types/domain";
import { correctInternalCheckin } from "./corrections";

export type QueueActor = { uid: string; profile: UserDoc };
type RecordData = StoredCheckin &
  Partial<QueueVisit> & { clientNameSnapshot?: string | null };
const idSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[^/]+$/);
const sharedSchema = z
  .object({
    booking: z.string().max(1000),
    sample: z.string().max(500),
    observation: z.string().max(2000),
  })
  .strict();
const issueSchema = z
  .object({
    id: idSchema,
    description: z.string().trim().min(1).max(500),
    resolved: z.boolean(),
  })
  .strict();
const correctionSchema = z
  .object({
    driverName: z.string().max(120).optional(),
    driverLicense: z.string().max(30).optional(),
    driverPhone: z.string().max(30).optional(),
    plate: z.string().max(15).optional(),
    carrierName: z.string().max(120).optional(),
    product: z.string().max(120).optional(),
    originPlant: z.string().max(120).optional(),
    vehicleType: z.enum(["Bitrem", "Rodotrem", "Vanderleia"]).optional(),
    originInvoiceNumbers: z.string().max(250).optional(),
    remittanceInvoiceNumber: z.string().max(250).optional(),
  })
  .strict();
export const queueCommandSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    command: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("CLASSIFY"),
          clientId: z.union([idSchema, z.literal("")]),
          shared: sharedSchema,
          issues: z
            .array(issueSchema)
            .max(50)
            .refine(
              (items) => new Set(items.map((i) => i.id)).size === items.length,
              "Pendências duplicadas.",
            ),
        })
        .strict(),
      z.object({ kind: z.literal("SHARED"), shared: sharedSchema }).strict(),
      z
        .object({
          kind: z.literal("TRANSITION"),
          toStatus: z.enum(["AGUARDANDO_CHAMADA", "CHAMADO", "CONCLUIDO"]),
        })
        .strict(),
      z
        .object({
          kind: z.literal("CORRECT"),
          patch: correctionSchema,
          reason: z.string().trim().min(1).max(500),
        })
        .strict(),
    ]),
  })
  .strict();
export function assertQueueActor(actor: QueueActor) {
  if (!actor.uid || !actor.profile.active || !actor.profile.approved)
    throw new HttpError(403, "Acesso não autorizado.");
  if (
    !["ANALYST", "SUPERVISOR", "ADMIN", "CUSTOMER"].includes(actor.profile.role)
  )
    throw new HttpError(403, "Perfil sem acesso à gestão da fila.");
}
function clientDto(
  id: string,
  data: FirebaseFirestore.DocumentData,
): QueueClient {
  return {
    id,
    name: String(data.name),
    portalEnabled: data.portalEnabled === true,
    usesSample: data.usesSample !== false,
  };
}
async function customerContext(
  actor: QueueActor,
): Promise<QueueClient | undefined> {
  assertQueueActor(actor);
  if (actor.profile.role !== "CUSTOMER") return undefined;
  if (!actor.profile.clientId)
    throw new HttpError(403, "Cliente não vinculado à conta.");
  const snap = await adminDb
    .collection("clients")
    .doc(idSchema.parse(actor.profile.clientId))
    .get();
  if (
    !snap.exists ||
    snap.data()?.active !== true ||
    snap.data()?.portalEnabled !== true
  )
    throw new HttpError(403, "Acesso do cliente não habilitado.");
  return clientDto(snap.id, snap.data()!);
}
function dto(data: RecordData, id: string, customer?: QueueClient): QueueVisit {
  const value: QueueVisit = {
    id,
    publicCode: data.publicCode,
    plate: data.plate,
    driverName: data.driverName,
    carrierName: data.carrierName,
    product: data.product,
    originPlant: data.originPlant,
    originInvoiceNumbers: data.originInvoiceNumbers,
    remittanceInvoiceNumber: data.remittanceInvoiceNumber,
    vehicleType: data.vehicleType,
    clientId: data.clientId ?? null,
    clientName: data.clientNameSnapshot ?? null,
    status: data.status,
    version: data.version,
    booking: data.booking ?? "",
    sample: data.sample ?? "",
    observation: data.observation ?? "",
    usesSample: customer?.usesSample ?? data.usesSample !== false,
    confirmedAtIso: data.confirmedAtIso,
    updatedAtIso: data.updatedAtIso,
    updatedBy: data.updatedBy ?? "Sistema",
    issues: data.issues ?? [],
    location: data.location ?? null,
    driverLicense: data.driverLicense,
    driverPhone: data.driverPhone,
    ...(data.document?{document:data.document}:{}),
  };
  return customer ? publicCustomerVisit(value) : value;
}
export async function listQueuePage(actor: QueueActor, cursor?: string) {
  const customer = await customerContext(actor);
  let query: FirebaseFirestore.Query = adminDb.collection("checkins");
  if (customer) query = query.where("clientId", "==", customer.id);
  query = query
    .orderBy("createdAtIso", "desc")
    .orderBy(FieldPath.documentId(), "desc");
  if (cursor) {
    const snapshot = await adminDb
      .collection("checkins")
      .doc(idSchema.parse(cursor))
      .get();
    if (
      !snapshot.exists ||
      (customer && snapshot.data()?.clientId !== customer.id)
    )
      throw new HttpError(400, "Cursor inválido.");
    query = query.startAfter(snapshot.data()!.createdAtIso, snapshot.id);
  }
  const rows = await query.limit(101).get();
  const page = rows.docs.slice(0, 100);
  const clients = customer
    ? [customer]
    : (
        await adminDb.collection("clients").where("active", "==", true).get()
      ).docs.map((d) => clientDto(d.id, d.data()));
  return {
    items: page
      .filter((d) => d.data().confirmedAtIso)
      .map((d) => dto(d.data() as RecordData, d.id, customer)),
    clients,
    nextCursor: rows.docs.length > 100 ? page.at(-1)!.id : null,
  };
}
export async function getQueueVisit(actor: QueueActor, id: string) {
  const customer = await customerContext(actor);
  const ref = adminDb.collection("checkins").doc(idSchema.parse(id));
  const snap = await ref.get();
  if (
    !snap.exists ||
    !snap.data()?.confirmedAtIso ||
    (customer && snap.data()?.clientId !== customer.id)
  )
    throw new HttpError(404, "Visita não encontrada.");
  const visit = dto(snap.data() as RecordData, id, customer);
  if (!customer) {
    const history = await ref
      .collection("revisions")
      .orderBy("createdAtIso", "desc")
      .limit(50)
      .get();
    visit.revisions = history.docs.map((d) => {
      const v = d.data();
      return {
        id: d.id,
        action: v.action,
        actor: v.actor ?? v.actorUid ?? v.source ?? "Sistema",
        at: v.createdAtIso,
        fields: v.changedFields ?? [],
      } as QueueRevision;
    });
  }
  return visit;
}
export async function mutateQueue(actor: QueueActor, id: string, raw: unknown) {
  assertQueueActor(actor);
  const { expectedVersion, command } = queueCommandSchema.parse(raw);
  if (actor.profile.role === "CUSTOMER" && command.kind !== "SHARED")
    throw new HttpError(
      403,
      "O cliente pode editar somente Booking, Amostra e Observação.",
    );
  if (command.kind === "CORRECT") {
    await correctInternalCheckin({
      actor: { uid: actor.uid, role: actor.profile.role },
      checkinId: idSchema.parse(id),
      expectedVersion,
      patch: command.patch,
      reason: command.reason,
      nowIso: new Date().toISOString(),
    });
    return getQueueVisit(actor, id);
  }
  const ref = adminDb.collection("checkins").doc(idSchema.parse(id));
  await adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const stored = snap.data() as RecordData | undefined;
    if (!snap.exists || !stored)
      throw new HttpError(404, "Visita não encontrada.");
    const user = await tx.get(adminDb.collection("users").doc(actor.uid));
    const profile = user.data() as UserDoc | undefined;
    if (!profile) throw new HttpError(403, "Perfil indisponível.");
    assertQueueActor({ uid: actor.uid, profile });
    if (
      profile.role !== actor.profile.role ||
      profile.clientId !== actor.profile.clientId
    )
      throw new HttpError(
        409,
        "As permissões foram alteradas. Atualize a sessão.",
      );
    let customer: QueueClient | undefined;
    const clientId =
      command.kind === "CLASSIFY" ? command.clientId : stored.clientId;
    const clientSnap = clientId
      ? await tx.get(adminDb.collection("clients").doc(clientId))
      : null;
    const clients =
      clientSnap?.exists && clientSnap.data()?.active === true
        ? [clientDto(clientSnap.id, clientSnap.data()!)]
        : [];
    if (profile.role === "CUSTOMER") {
      if (!profile.clientId || stored.clientId !== profile.clientId)
        throw new HttpError(404, "Visita não encontrada.");
      customer = clients[0];
      if (!customer?.portalEnabled)
        throw new HttpError(403, "Acesso do cliente não habilitado.");
    }
    if (stored.version !== expectedVersion)
      throw new HttpError(
        409,
        "Outra pessoa alterou esta visita. Seu preenchimento foi mantido. Atualize para carregar a versão atual e reaplicar sua alteração.",
      );
    if (stored.pendingOfficialMutation || stored.status === "PRE_CADASTRO")
      throw new HttpError(409, "A visita ainda não tem check-in confirmado.");
    if(command.kind === "TRANSITION" && ["AGUARDANDO_CHAMADA","CHAMADO"].includes(command.toStatus) && stored.document && (stored.document.status!=="received" || !stored.document.current))
      throw new HttpError(409,"A Line precisa receber a nota fiscal antes de liberar ou chamar esta visita.");
    const before = dto(stored, id);
    if (
      customer &&
      !customer.usesSample &&
      command.kind === "SHARED" &&
      command.shared.sample !== before.sample
    )
      throw new HttpError(400, "Amostra não utilizada por este cliente.");
    let after: QueueVisit;
    try {
      after = applyQueueCommand(before, command, clients, customer);
    } catch (e) {
      throw new HttpError(
        customer ? 403 : 409,
        e instanceof Error ? e.message : "Alteração inválida.",
      );
    }
    const now = new Date().toISOString();
    const patch =
      command.kind === "CLASSIFY"
        ? {
            clientId: after.clientId,
            clientNameSnapshot: after.clientName,
            booking: after.booking,
            sample: after.sample,
            observation: after.observation,
            issues: after.issues ?? [],
            usesSample: after.usesSample,
          }
        : command.kind === "SHARED"
          ? {
              booking: after.booking,
              sample: after.sample,
              observation: after.observation,
            }
          : { status: after.status };
    const changedFields = Object.keys(patch).filter(
      (k) =>
        JSON.stringify(stored[k as keyof RecordData]) !==
        JSON.stringify(patch[k as keyof typeof patch]),
    );
    if (!changedFields.length) return;
    const actorName =
      profile.role === "CUSTOMER"
        ? `${profile.name || profile.email || "Usuário"} (${customer!.name})`
        : profile.name || "Equipe Line";
    tx.update(ref, {
      ...patch,
      version: stored.version + 1,
      updatedAtIso: now,
      updatedBy: actorName,
    });
    tx.create(ref.collection("revisions").doc(), {
      action:
        command.kind === "TRANSITION"
          ? "Status alterado"
          : "Informações atualizadas",
      actor: actorName,
      actorUid: actor.uid,
      actorRole: profile.role,
      changedFields,
      previousVersion: stored.version,
      newVersion: stored.version + 1,
      createdAtIso: now,
      before: Object.fromEntries(
        changedFields.map((k) => [k, stored[k as keyof RecordData] ?? null]),
      ),
      after: patch,
    });
    if (closedVisit(after.status) && !closedVisit(before.status)) {
      for (const [kind, index] of [
        ["plate", stored.plateIndex],
        ["cnh", stored.driverLicenseIndex],
      ])
        tx.delete(
          adminDb
            .collection("_checkinUniqueLocks")
            .doc(`${kind}_${index.replace(":", "_")}`),
        );
    }
  });
  return getQueueVisit(actor, id);
}
