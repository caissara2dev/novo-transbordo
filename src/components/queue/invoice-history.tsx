"use client";
import { useRef, useState } from "react";
import { apiFetch, ApiRequestError } from "@/lib/auth/api-fetch";
import type { DocumentHistoryItem, DocumentHistoryPage } from "@/lib/domain/checkin-document";
import type { QueueVisit } from "@/lib/domain/queue";
import { InvoiceDelete } from "./invoice-delete";

const date = (value: string) => new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short", timeStyle: "short",
}).format(new Date(value));
const size = (bytes: number) => new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(bytes / 1_000_000);

/** Private version metadata is only requested when Line opens the history. */
export function InvoiceHistory({ endpoint, visit, canDelete = false, onDeleted }: {
  endpoint: string; visit?: QueueVisit; canDelete?: boolean; onDeleted?: (visit: QueueVisit) => void;
}) {
  const [items, setItems] = useState<DocumentHistoryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [downloadError, setDownloadError] = useState("");
  const [downloading, setDownloading] = useState("");
  const loading = useRef(false);
  const downloadingRef = useRef(false);

  async function load(refresh = false) {
    if (loading.current) return;
    loading.current = true; setBusy(true); setError("");
    try {
      const query = new URLSearchParams({ history: "true" });
      if (!refresh && loaded && cursor) query.set("cursor", cursor);
      const result = await apiFetch<DocumentHistoryPage>(`${endpoint}?${query}`, { cache: "no-store" });
      setItems((previous) => {
        const versions = new Map((refresh ? [] : previous).map((item) => [item.id, item]));
        for (const item of result.items) versions.set(item.id, item);
        return [...versions.values()];
      });
      setCursor(result.nextCursor); setLoaded(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Não foi possível consultar o histórico das notas.");
    } finally { loading.current = false; setBusy(false); }
  }
  async function download(item: DocumentHistoryItem) {
    if (downloadingRef.current || !item.available) return;
    downloadingRef.current = true; setDownloading(item.id); setDownloadError("");
    try {
      const query = new URLSearchParams({ version: item.id });
      const result = await apiFetch<{ url: string; name: string }>(`${endpoint}?${query}`, { cache: "no-store" });
      const link = document.createElement("a");
      link.href = result.url; link.download = result.name; link.rel = "noreferrer"; link.click();
    } catch (failure) {
      if (failure instanceof ApiRequestError && failure.status === 410)
        setItems((previous) => previous.map((version) => version.id === item.id ? { ...version, available: false } : version));
      setDownloadError(failure instanceof Error ? failure.message : "Não foi possível baixar a versão anterior.");
    } finally { downloadingRef.current = false; setDownloading(""); }
  }

  return <details className="q-invoice-history" onToggle={(event) => {
    if (event.currentTarget.open && !loaded) void load();
  }}>
    <summary>Histórico dos documentos</summary>
    <p className="q-help">O documento atual vence 12 meses após conclusão ou cancelamento. Versões substituídas ficam disponíveis por 90 dias após a troca. O registro textual permanece após a remoção.</p>
    {items.length ? <ol>{items.map((item) => <li key={item.id}>
      <div className="q-invoice-file"><strong>{item.contentType === "application/pdf" ? "PDF anterior" : "Foto anterior"}</strong><span>{size(item.size)} MB</span>
        <span className="q-invoice-filename">{item.name}</span></div>
      <p>{item.kind === "manual-deletion" ? "Exclusão solicitada" : item.kind === "current-expiration" ? "Prazo documental encerrado" : "Substituída"} por {item.replacedBy} em {date(item.replacedAtIso)}.</p>
      {item.deletion ? <p className="q-help">{item.deletion.actorName} · {date(item.deletion.requestedAtIso)} · {item.deletion.reason}</p> : null}
      {item.available ? <>
        <p className="q-help">Disponível até {date(item.expiresAtIso)}.</p>
        <button className="btn-soft" type="button" disabled={Boolean(downloading)} onClick={() => void download(item)}>
          {downloading === item.id ? "Preparando download…" : "Baixar versão anterior"}
        </button>
        {canDelete && visit ? <InvoiceDelete visit={visit} documentId={item.id} name={item.name} disabled={Boolean(downloading)} onDeleted={onDeleted} /> : null}
      </> : <p className="q-help">Arquivo indisponível. {item.state === "deletion-requested" || item.state === "deleting" ? "Exclusão em processamento." : item.state === "deleted" ? "Arquivo excluído." : "Prazo encerrado; remoção em processamento."} O registro textual foi preservado.{item.deletedAtIso ? ` Removido em ${date(item.deletedAtIso)}.` : ""}</p>}
    </li>)}</ol> : loaded ? <p className="q-help">Ainda não há versões anteriores desta nota.</p> : null}
    {busy ? <p role="status">Carregando histórico…</p> : null}
    {error ? <p className="q-error" role="alert">{error}</p> : null}
    {downloadError ? <p className="q-error" role="alert">{downloadError}</p> : null}
    {loaded ? <button className="q-link" type="button" disabled={busy} onClick={() => void load(true)}>Atualizar histórico dos documentos</button> : null}
    {error || cursor ? <button type="button" className="btn-soft" disabled={busy} onClick={() => void load()}>
      {error ? "Tentar carregar histórico novamente" : "Carregar mais documentos"}
    </button> : null}
  </details>;
}
