"use client";

import { FormEvent, useState } from "react";
import type { CheckinStatus, DriverCheckinForm } from "@/lib/domain/checkins";
import type { ClientApiItem } from "@/types/api";
import {
  formatCheckinDate,
  formatMeters,
  statusLabel
} from "./checkins-ui";
import type { InternalCheckinDetail } from "./checkins-ui";

export type CheckinManagerAction =
  | {
      kind: "ASSIGN_CLIENT";
      clientId: string;
      expectedVersion: number;
      reason: string;
    }
  | {
      kind: "TRANSITION";
      toStatus: CheckinStatus;
      expectedVersion: number;
      reason: string;
    }
  | {
      kind: "CANCEL";
      expectedVersion: number;
      reason: string;
    }
  | {
      kind: "LOCATION_OVERRIDE";
      expectedVersion: number;
      justification: string;
    }
  | {
      kind: "CORRECT";
      patch: Partial<DriverCheckinForm>;
      expectedVersion: number;
      reason: string;
    };

type Props = {
  detail: InternalCheckinDetail | null;
  loading: boolean;
  canManage: boolean;
  clients: ClientApiItem[];
  actionPending: boolean;
  onAction: (action: CheckinManagerAction) => Promise<void>;
};

const manualTransitions: Partial<Record<CheckinStatus, CheckinStatus[]>> = {
  AGUARDANDO_LIBERACAO: ["AGUARDANDO_CHAMADA"],
  AGUARDANDO_CHAMADA: ["CHAMADO"],
  // A wrong productive selection is undone from the event history so the
  // event deletion and the queue rollback remain one audited transaction.
  EM_DESCARGA: ["CONCLUIDO"]
};

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value || "—"}</dd>
    </div>
  );
}

function ManagerActions({
  detail,
  clients,
  pending,
  onAction
}: {
  detail: InternalCheckinDetail;
  clients: ClientApiItem[];
  pending: boolean;
  onAction: Props["onAction"];
}) {
  const [clientId, setClientId] = useState(detail.clientId ?? "");
  const [clientReason, setClientReason] = useState("");
  const [transition, setTransition] = useState<CheckinStatus | "">("");
  const [transitionReason, setTransitionReason] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [correction, setCorrection] = useState({
    driverName: detail.driverName,
    driverLicense: detail.driverLicense ?? "",
    driverPhone: detail.driverPhone ?? "",
    plate: detail.plate,
    carrierName: detail.carrierName,
    vehicleType: detail.vehicleType ?? "Bitrem",
    product: detail.product,
    originPlant: detail.originPlant ?? "",
    originInvoiceNumbers: detail.originInvoiceNumbers ?? "",
    remittanceInvoiceNumber: detail.remittanceInvoiceNumber ?? ""
  });
  const transitions = manualTransitions[detail.status] ?? [];

  const submitClient = async (event: FormEvent) => {
    event.preventDefault();
    await onAction({
      kind: "ASSIGN_CLIENT",
      clientId,
      expectedVersion: detail.version,
      reason: clientReason
    });
  };

  const submitTransition = async (event: FormEvent) => {
    event.preventDefault();
    if (!transition) return;
    await onAction({
      kind: "TRANSITION",
      toStatus: transition,
      expectedVersion: detail.version,
      reason: transitionReason
    });
  };

  const submitCorrection = async (event: FormEvent) => {
    event.preventDefault();
    await onAction({
      kind: "CORRECT",
      patch: correction,
      expectedVersion: detail.version,
      reason: correctionReason
    });
  };

  return (
    <section aria-label="Ações de supervisão" className="checkins-manager-actions">
      <h3>Ações de supervisão</h3>
      <p>Toda alteração exige motivo e entra no histórico de auditoria.</p>

      <details>
        <summary>Atribuir cliente</summary>
        <form onSubmit={submitClient}>
          <label className="field-label">
            Cliente
            <select
              onChange={(event) => setClientId(event.target.value)}
              required
              value={clientId}
            >
              <option value="">Selecione</option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            Motivo
            <textarea
              maxLength={500}
              onChange={(event) => setClientReason(event.target.value)}
              required
              value={clientReason}
            />
          </label>
          <button className="btn-primary" disabled={pending} type="submit">
            Confirmar cliente
          </button>
        </form>
      </details>

      {transitions.length ? (
        <details>
          <summary>Alterar status</summary>
          <form onSubmit={submitTransition}>
            <label className="field-label">
              Próximo status
              <select
                onChange={(event) =>
                  setTransition(event.target.value as CheckinStatus | "")
                }
                required
                value={transition}
              >
                <option value="">Selecione</option>
                {transitions.map((status) => (
                  <option key={status} value={status}>
                    {statusLabel(status)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-label">
              Motivo
              <textarea
                maxLength={500}
                onChange={(event) => setTransitionReason(event.target.value)}
                required
                value={transitionReason}
              />
            </label>
            <button className="btn-primary" disabled={pending} type="submit">
              Atualizar status
            </button>
          </form>
        </details>
      ) : null}

      <details>
        <summary>Corrigir dados</summary>
        <form className="checkins-correction-grid" onSubmit={submitCorrection}>
          <label className="field-label">
            Motorista
            <input
              onChange={(event) =>
                setCorrection((current) => ({
                  ...current,
                  driverName: event.target.value
                }))
              }
              required
              value={correction.driverName}
            />
          </label>
          <label className="field-label">
            CNH
            <input
              inputMode="numeric"
              onChange={(event) =>
                setCorrection((current) => ({
                  ...current,
                  driverLicense: event.target.value
                }))
              }
              required
              value={correction.driverLicense}
            />
          </label>
          <label className="field-label">
            Telefone
            <input
              inputMode="tel"
              onChange={(event) =>
                setCorrection((current) => ({
                  ...current,
                  driverPhone: event.target.value
                }))
              }
              required
              value={correction.driverPhone}
            />
          </label>
          <label className="field-label">
            Placa
            <input
              onChange={(event) =>
                setCorrection((current) => ({ ...current, plate: event.target.value }))
              }
              required
              value={correction.plate}
            />
          </label>
          <label className="field-label">
            Transportadora
            <input
              onChange={(event) =>
                setCorrection((current) => ({
                  ...current,
                  carrierName: event.target.value
                }))
              }
              required
              value={correction.carrierName}
            />
          </label>
          <label className="field-label">
            Tipo de veículo
            <select
              onChange={(event) =>
                setCorrection((current) => ({
                  ...current,
                  vehicleType: event.target.value as typeof current.vehicleType
                }))
              }
              value={correction.vehicleType}
            >
              <option value="Bitrem">Bitrem</option>
              <option value="Rodotrem">Rodotrem</option>
              <option value="Vanderleia">Vanderleia</option>
            </select>
          </label>
          <label className="field-label">
            Produto
            <input
              onChange={(event) =>
                setCorrection((current) => ({ ...current, product: event.target.value }))
              }
              required
              value={correction.product}
            />
          </label>
          <label className="field-label">
            Usina de origem
            <input
              onChange={(event) =>
                setCorrection((current) => ({
                  ...current,
                  originPlant: event.target.value
                }))
              }
              required
              value={correction.originPlant}
            />
          </label>
          <label className="field-label">
            NF de usina
            <input
              onChange={(event) =>
                setCorrection((current) => ({
                  ...current,
                  originInvoiceNumbers: event.target.value
                }))
              }
              required
              value={correction.originInvoiceNumbers}
            />
          </label>
          <label className="field-label">
            NF de remessa
            <input
              onChange={(event) =>
                setCorrection((current) => ({
                  ...current,
                  remittanceInvoiceNumber: event.target.value
                }))
              }
              required
              value={correction.remittanceInvoiceNumber}
            />
          </label>
          <label className="field-label checkins-grid-wide">
            Motivo da correção
            <textarea
              maxLength={500}
              onChange={(event) => setCorrectionReason(event.target.value)}
              required
              value={correctionReason}
            />
          </label>
          <button className="btn-primary checkins-grid-wide" disabled={pending} type="submit">
            Salvar correção
          </button>
        </form>
      </details>

      {detail.status === "PRE_CADASTRO" ? (
        <details className="checkins-action-warning">
          <summary>Confirmar sem GPS válido</summary>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              await onAction({
                kind: "LOCATION_OVERRIDE",
                expectedVersion: detail.version,
                justification: overrideReason
              });
            }}
          >
            <div className="notice warn">
              Esta exceção será destacada na auditoria. Use somente após confirmar a
              chegada por outro meio.
            </div>
            <label className="field-label">
              Justificativa
              <textarea
                maxLength={500}
                onChange={(event) => setOverrideReason(event.target.value)}
                required
                value={overrideReason}
              />
            </label>
            <button className="btn-danger" disabled={pending} type="submit">
              Confirmar exceção
            </button>
          </form>
        </details>
      ) : null}

      {detail.status !== "CONCLUIDO" && detail.status !== "CANCELADO" ? (
        <details className="checkins-action-danger">
          <summary>Cancelar visita</summary>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              await onAction({
                kind: "CANCEL",
                expectedVersion: detail.version,
                reason: cancelReason
              });
            }}
          >
            <label className="field-label">
              Motivo do cancelamento
              <textarea
                maxLength={500}
                onChange={(event) => setCancelReason(event.target.value)}
                required
                value={cancelReason}
              />
            </label>
            <button className="btn-danger" disabled={pending} type="submit">
              Cancelar visita
            </button>
          </form>
        </details>
      ) : null}
    </section>
  );
}

export function CheckinDetailPanel({
  detail,
  loading,
  canManage,
  clients,
  actionPending,
  onAction
}: Props) {
  if (loading) {
    return <p className="checkins-empty">Carregando detalhes...</p>;
  }
  if (!detail) {
    return (
      <div className="checkins-empty">
        <strong>Selecione um check-in</strong>
        <span>Os detalhes da visita aparecerão aqui.</span>
      </div>
    );
  }

  return (
    <div className="checkins-detail-content">
      <header>
        <div>
          <span className={`checkin-status status-${detail.status.toLowerCase()}`}>
            {statusLabel(detail.status)}
          </span>
          <h2>{detail.plate}</h2>
          <p>{detail.driverName}</p>
        </div>
        <span className="checkins-version">v{detail.version}</span>
      </header>

      <dl className="checkins-detail-grid">
        <DetailRow label="Transportadora" value={detail.carrierName} />
        <DetailRow label="Produto" value={detail.product} />
        <DetailRow label="Cliente" value={detail.clientName || "Não atribuído"} />
        {canManage ? (
          <>
            <DetailRow label="Código público" value={detail.publicCode} />
            <DetailRow label="CNH" value={detail.driverLicense} />
            <DetailRow label="Telefone" value={detail.driverPhone} />
            <DetailRow label="Veículo" value={detail.vehicleType} />
            <DetailRow label="Usina" value={detail.originPlant} />
            <DetailRow label="NF de usina" value={detail.originInvoiceNumbers} />
            <DetailRow label="NF de remessa" value={detail.remittanceInvoiceNumber} />
            <DetailRow label="Origem do cadastro" value={detail.source === "CARRIER" ? "Transportadora" : "Motorista"} />
            <DetailRow label="Sincronização Excel" value={detail.syncState} />
            <DetailRow label="Criado em" value={formatCheckinDate(detail.createdAtIso)} />
            <DetailRow label="Confirmado em" value={formatCheckinDate(detail.confirmedAtIso)} />
          </>
        ) : null}
      </dl>

      {canManage && detail.geofence ? (
        <section className="checkins-location-summary" aria-label="Validação de localização">
          <h3>Validação de localização</h3>
          <div>
            <span>Resultado</span>
            <strong>{detail.geofence.allowed ? "Dentro do raio" : "Não validado"}</strong>
          </div>
          <div>
            <span>Distância aproximada</span>
            <strong>{formatMeters(detail.geofence.distanceMeters)}</strong>
          </div>
          <div>
            <span>Precisão do GPS</span>
            <strong>{formatMeters(detail.geofence.accuracyMeters)}</strong>
          </div>
          <div>
            <span>Validado em</span>
            <strong>{formatCheckinDate(detail.geofence.validatedAtIso)}</strong>
          </div>
        </section>
      ) : null}

      {canManage && detail.locationOverride ? (
        <div className="notice warn">
          Exceção de GPS: {detail.locationOverride.justification} · autorizada por {detail.locationOverride.approvedByRole} em {formatCheckinDate(detail.locationOverride.approvedAtIso)}.
        </div>
      ) : null}

      {canManage ? (
        <ManagerActions
          key={`${detail.id}:${detail.version}`}
          clients={clients}
          detail={detail}
          onAction={onAction}
          pending={actionPending}
        />
      ) : null}

      {canManage ? (
        <section className="checkins-audit" aria-label="Histórico de auditoria">
          <h3>Auditoria</h3>
          {detail.revisions?.map((revision) => (
            <article
              className={revision.highlight === "GPS_BYPASS" ? "highlight" : ""}
              key={revision.id}
            >
              <div>
                <strong>{revision.action || "ALTERAÇÃO"}</strong>
                <span>{formatCheckinDate(revision.createdAtIso)}</span>
              </div>
              <p>{revision.reason || "Sem motivo informado"}</p>
              <small>{revision.actorRole || "SISTEMA"}</small>
            </article>
          ))}
          {!detail.revisions?.length ? <p className="muted">Sem revisões registradas.</p> : null}
        </section>
      ) : null}
    </div>
  );
}
