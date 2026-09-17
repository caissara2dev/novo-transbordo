"use client";
/* eslint-disable @next/next/no-img-element -- Already optimized private image: avoid proxying signed URLs through Next Image. */
import { useRef, useState } from "react";
import { apiFetch, ApiRequestError } from "@/lib/auth/api-fetch";
import type { QueueVisit } from "@/lib/domain/queue";
import { uploadInvoice, validateInvoiceFile } from "./invoice-upload";
import "./invoice-summary.css";

type Reply = { sessionId: string; uploadUrl?: string; received: boolean; item?: QueueVisit };
type Operation = {
  id: string; expectedVersion: number; sessionId?: string; uploadUrl?: string; uploaded: boolean;
};
const formats = ".jpg,.jpeg,.png,.heic,.heif,.pdf,image/jpeg,image/png,image/heic,image/heif,application/pdf";
const size = (bytes: number) => new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(bytes / 1_000_000);

export function InvoiceSummary({ visit, canAttach = false, onReceived }: {
  visit: QueueVisit;
  canAttach?: boolean;
  onReceived?: (item: QueueVisit) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState("");
  const [selected, setSelected] = useState<File | null>(null);
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState("");
  const [message, setMessage] = useState("");
  const [retry, setRetry] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const operation = useRef<Operation | null>(null);
  const inFlight = useRef(false);
  const invoice = visit.document;
  if (!invoice) return null;
  const mayAttach = canAttach && invoice.status === "pending" && !invoice.current;
  const endpoint = `/api/checkins/${encodeURIComponent(visit.id)}/document`;

  async function open(asPreview: boolean) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError(""); setPhase("");
    try {
      const result = await apiFetch<{ url: string; name: string }>(`${endpoint}${asPreview ? "?preview=true" : ""}`, { cache: "no-store" });
      if (asPreview) setPreview(result.url);
      else {
        const link = document.createElement("a");
        link.href = result.url; link.download = result.name; link.rel = "noreferrer"; link.click();
      }
    } catch (error) { setError(error instanceof Error ? error.message : "Não foi possível abrir a nota."); }
    finally { inFlight.current = false; setBusy(false); }
  }
  function choose(file: File | undefined) {
    if (!file || inFlight.current) return;
    setError(""); setMessage("");
    try {
      validateInvoiceFile(file);
      operation.current = null;
      setSelected(file); setRetry(false); setProgress(0);
    } catch (error) { setError((error as Error).message); }
  }
  function accept(reply: Reply) {
    if (!reply.received || !reply.item)
      throw new Error("O recebimento ainda não foi confirmado. Tente novamente para consultar o resultado.");
    onReceived?.(reply.item);
    setMessage("Nota recebida e vinculada à visita. A liberação continua sendo uma ação separada da Line.");
    setSelected(null); setRetry(false); operation.current = null;
  }
  async function send() {
    if (!selected || !mayAttach || inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError(""); setMessage(""); setPhase("Preparando envio…");
    const active = operation.current ?? {
      id: crypto.randomUUID(), expectedVersion: visit.version, uploaded: false,
    };
    operation.current = active;
    try {
      if (!active.sessionId || !active.uploadUrl) {
        const begin = await apiFetch<Reply>(endpoint, {
          method: "POST",
          body: JSON.stringify({ action: "begin", operationId: active.id, expectedVersion: active.expectedVersion, name: selected.name, size: selected.size }),
        });
        if (begin.received) { accept(begin); return; }
        active.sessionId = begin.sessionId; active.uploadUrl = begin.uploadUrl;
      }
      if (!active.uploaded) {
        if (!active.uploadUrl) throw new Error("O envio ainda não foi preparado. Tente novamente.");
        setPhase("Enviando nota");
        try {
          await uploadInvoice(selected, active.uploadUrl, setProgress);
          active.uploaded = true;
        } catch (uploadError) {
          // A lost Storage response can still mean the upload finished successfully.
          setPhase("Conferindo o resultado do envio…");
          try {
            const result = await apiFetch<Reply>(endpoint, { method: "POST", body: JSON.stringify({ action: "finalize", sessionId: active.sessionId }) });
            accept(result); return;
          } catch (checkError) {
            if (checkError instanceof ApiRequestError) throw checkError;
            throw uploadError;
          }
        }
      }
      setPhase("Conferindo o arquivo recebido…");
      const result = await apiFetch<Reply>(endpoint, {
        method: "POST", body: JSON.stringify({ action: "finalize", sessionId: active.sessionId }),
      });
      accept(result);
    } catch (error) {
      if (error instanceof ApiRequestError && [410, 422].includes(error.status)) operation.current = null;
      setRetry(true);
      setError(error instanceof Error && !(error instanceof TypeError) ? error.message : "Não foi possível confirmar o envio. O arquivo e seu preenchimento foram mantidos; tente novamente.");
    } finally { inFlight.current = false; setBusy(false); }
  }

  return <section className="q-section q-invoice" aria-label="Nota fiscal" aria-busy={busy}>
    <h3>Nota fiscal <span>Somente Line</span></h3>
    {invoice.status === "pending" ? <>
      <p>Documento pendente. A liberação e a chamada estão bloqueadas até o recebimento da nota.</p>
      {mayAttach ? <>
        <p className="q-help">Anexe a foto ou o PDF recebido do motorista, de até 10 MB. O documento ficará vinculado somente a esta visita.</p>
        <input ref={picker} aria-label="Arquivo da nota fiscal" type="file" accept={formats} hidden
          onChange={(event) => { choose(event.target.files?.[0]); event.target.value = ""; }} />
        {selected ? <div className="q-invoice-file">
          <strong>{selected.type === "application/pdf" || /\.pdf$/i.test(selected.name) ? "PDF da nota" : "Foto da nota"}</strong>
          <span>{size(selected.size)} MB</span>
          <span className="q-invoice-filename" title={selected.name}>{selected.name}</span>
        </div> : null}
        <div className="q-inline-actions">
          <button type="button" className="btn-soft" disabled={busy} onClick={() => picker.current?.click()}>
            {selected ? "Escolher outro arquivo" : "Anexar foto ou PDF"}
          </button>
          {selected ? <button type="button" className="q-primary" disabled={busy} onClick={() => void send()}>
            {busy ? "Aguarde…" : retry ? "Tentar novamente" : "Enviar nota"}
          </button> : null}
          {selected && !retry && !busy ? <button type="button" className="q-link" onClick={() => { setSelected(null); setError(""); }}>Cancelar seleção</button> : null}
        </div>
      </> : null}
    </> : <>
      <p className="q-invoice-file"><strong>Documento recebido</strong><span>{size(invoice.current?.size ?? 0)} MB</span>
        <span className="q-invoice-filename" title={invoice.current?.name}>{invoice.current?.name}</span></p>
      <div className="q-inline-actions">
        <button className="btn-soft" type="button" disabled={busy} onClick={() => void open(false)}>Baixar original</button>
        {invoice.current?.previewStatus === "ready" ? <button className="btn-soft" type="button" disabled={busy} onClick={() => void open(true)}>Visualizar nota</button> : null}
      </div>
      {invoice.current?.previewStatus !== "ready" && invoice.current?.previewStatus !== "not-applicable" ? <p className="q-help">Prévia {invoice.current?.previewStatus === "failed" ? "indisponível; original preservado" : "em processamento"}.</p> : null}
      {preview ? <a href={preview} target="_blank" rel="noreferrer"><img src={preview} alt="Prévia da nota fiscal desta visita" /></a> : null}
    </>}
    <div aria-live="polite">{busy && phase ? <><progress max={100} value={progress} aria-label="Envio da nota fiscal" /><p>{phase === "Enviando nota" ? `Enviando nota: ${progress}%` : phase}</p></> : null}</div>
    {message ? <p className="q-notice" role="status">{message}</p> : null}
    {error ? <p className="q-error" role="alert">{error}</p> : null}
  </section>;
}
