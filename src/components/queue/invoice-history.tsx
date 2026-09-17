"use client";
import { useRef, useState } from "react";
import { apiFetch, ApiRequestError } from "@/lib/auth/api-fetch";
import type { DocumentHistoryItem, DocumentHistoryPage } from "@/lib/domain/checkin-document";

const date = (value: string) => new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short", timeStyle: "short",
}).format(new Date(value));
const size = (bytes: number) => new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(bytes / 1_000_000);

/** Private version metadata is only requested when Line opens the history. */
export function InvoiceHistory({ endpoint }: { endpoint: string }) {
  const [items, setItems] = useState<DocumentHistoryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [downloadError, setDownloadError] = useState("");
  const [downloading, setDownloading] = useState("");
  const loading = useRef(false);
  const downloadingRef = useRef(false);

  async function load() {
    if (loading.current) return;
    loading.current = true; setBusy(true); setError("");
    try {
      const query = new URLSearchParams({ history: "true" });
      if (loaded && cursor) query.set("cursor", cursor);
      const result = await apiFetch<DocumentHistoryPage>(`${endpoint}?${query}`, { cache: "no-store" });
      setItems((previous) => {
        const versions = new Map(previous.map((item) => [item.id, item]));
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
    <p className="q-help">Versões substituídas ficam disponíveis por 90 dias após a troca. O registro da alteração permanece após a remoção do arquivo.</p>
    {items.length ? <ol>{items.map((item) => <li key={item.id}>
      <div className="q-invoice-file"><strong>{item.contentType === "application/pdf" ? "PDF anterior" : "Foto anterior"}</strong><span>{size(item.size)} MB</span>
        <span className="q-invoice-filename">{item.name}</span></div>
      <p>Substituída por {item.replacedBy} em {date(item.replacedAtIso)}.</p>
      {item.available ? <>
        <p className="q-help">Disponível até {date(item.expiresAtIso)}.</p>
        <button className="btn-soft" type="button" disabled={Boolean(downloading)} onClick={() => void download(item)}>
          {downloading === item.id ? "Preparando download…" : "Baixar versão anterior"}
        </button>
      </> : <p className="q-help">Arquivo indisponível. O registro da substituição foi preservado.</p>}
    </li>)}</ol> : loaded ? <p className="q-help">Ainda não há versões anteriores desta nota.</p> : null}
    {busy ? <p role="status">Carregando histórico…</p> : null}
    {error ? <p className="q-error" role="alert">{error}</p> : null}
    {downloadError ? <p className="q-error" role="alert">{downloadError}</p> : null}
    {error || cursor ? <button type="button" className="btn-soft" disabled={busy} onClick={() => void load()}>
      {error ? "Tentar carregar histórico novamente" : "Carregar mais documentos"}
    </button> : null}
  </details>;
}
