"use client";
import { useId, useRef, useState } from "react";
import { apiFetch } from "@/lib/auth/api-fetch";
import type { QueueVisit } from "@/lib/domain/queue";

export function InvoiceDelete({ visit, documentId, name, current = false, disabled = false, onDeleted }: {
  visit: QueueVisit; documentId: string; name: string; current?: boolean; disabled?: boolean;
  onDeleted?: (visit: QueueVisit) => void;
}) {
  const reasonId = useId();
  const [confirmation, setConfirmation] = useState<{ version: number; operationId: string; documentId: string; name: string; code: string; plate: string } | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState<{ reason: string } | null>(null);
  const lock = useRef(false);
  async function remove() {
    if (!confirmation || !reason.trim() || lock.current) return;
    lock.current = true; setBusy(true); setError("");
    const receipt = submitted ?? { reason: reason.trim() };
    setSubmitted(receipt);
    try {
      const result = await apiFetch<{ item: QueueVisit }>(`/api/checkins/${encodeURIComponent(visit.id)}/document`, {
        method: "POST", body: JSON.stringify({ action: "delete", documentId: confirmation.documentId, expectedVersion: confirmation.version,
          operationId: confirmation.operationId, reason: receipt.reason }),
      });
      setConfirmation(null); setReason(""); setSubmitted(null);
      onDeleted?.(result.item);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Não foi possível confirmar a exclusão. Tente novamente para consultar o resultado.");
    } finally { lock.current = false; setBusy(false); }
  }
  return confirmation ? <div className="q-invoice-selection" role="group" aria-label="Confirmar exclusão da nota">
    <h4>Excluir este arquivo?</h4>
    <p>Visita {confirmation.code} · {confirmation.plate}</p>
    <p className="q-invoice-filename">{confirmation.name}</p>
    <p>O original e a prévia serão removidos definitivamente. O registro textual será preservado. Nenhuma versão anterior será restaurada.</p>
    {current ? <p>A etapa da visita será mantida. Sem nota, não será possível liberar, chamar ou iniciar uma nova descarga. Lançamentos salvos permanecem intactos.</p> : null}
    <label htmlFor={reasonId}>Motivo para excluir NF</label>
    <textarea id={reasonId} value={reason} maxLength={300} required disabled={busy || Boolean(submitted)}
      onChange={(event) => setReason(event.target.value)} />
    <p className="q-help">{reason.length}/300 caracteres</p>
    <div className="q-inline-actions">
      <button type="button" className="btn-soft" disabled={busy || !reason.trim()} onClick={() => void remove()}>
        {busy ? "Solicitando exclusão…" : submitted ? "Consultar / tentar novamente" : "Confirmar exclusão"}
      </button>
      <button type="button" className="q-link" disabled={busy} onClick={() => {
        setConfirmation(null); setReason(""); setError(""); setSubmitted(null);
      }}>Cancelar</button>
    </div>
    {error ? <p className="q-error" role="alert">{error}</p> : null}
  </div> : <button className="q-link" type="button" disabled={disabled} onClick={() => {
    setConfirmation({ version: visit.version, operationId: crypto.randomUUID(), documentId, name, code: visit.publicCode, plate: visit.plate });
  }}>Excluir arquivo…</button>;
}
