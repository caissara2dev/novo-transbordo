"use client";
/* eslint-disable @next/next/no-img-element -- Already optimized private image: avoid proxying signed URLs through Next Image. */
import { useState } from "react";
import { apiFetch } from "@/lib/auth/api-fetch";
import type { QueueVisit } from "@/lib/domain/queue";
export function InvoiceSummary({visit}:{visit:QueueVisit}) {
  const [busy,setBusy]=useState(false);const [error,setError]=useState("");const [preview,setPreview]=useState("");
  const invoice=visit.document;
  if(!invoice)return null;
  async function open(asPreview:boolean) {
    setBusy(true);setError("");
    try {
      const result=await apiFetch<{url:string;name:string}>(`/api/checkins/${encodeURIComponent(visit.id)}/document${asPreview?"?preview=true":""}`,{cache:"no-store"});
      if(asPreview)setPreview(result.url);else{const link=document.createElement("a");link.href=result.url;link.download=result.name;link.rel="noreferrer";link.click();}
    } catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <section className="q-section"><h3>Nota fiscal · uso interno Line</h3>
    {invoice.status==="pending"?<p>Documento pendente. A liberação e a chamada estão bloqueadas até o recebimento da nota.</p>:<>
      <p>{invoice.current?.name} · {((invoice.current?.size??0)/1_000_000).toFixed(2)} MB</p>
      <button className="btn-soft" type="button" disabled={busy} onClick={()=>void open(false)}>Baixar original</button>
      {invoice.current?.previewStatus==="ready"?<button className="btn-soft" type="button" disabled={busy} onClick={()=>void open(true)}>Visualizar nota</button>:invoice.current?.previewStatus!=="not-applicable"?<p>Prévia {invoice.current?.previewStatus==="failed"?"indisponível; original preservado":"em processamento"}.</p>:null}
      {preview?<a href={preview} target="_blank" rel="noreferrer"><img src={preview} alt="Prévia da nota fiscal desta visita" style={{maxWidth:"100%"}} /></a>:null}
    </>}
    {error?<p role="alert">{error}</p>:null}
  </section>;
}
