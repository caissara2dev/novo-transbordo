/* eslint-disable @next/next/no-img-element -- Offline Vite prototype: generated data URLs, without a Next.js image server. */
import { useEffect, useRef, useState } from "react";
import type { QueueRevision, QueueVisit } from "../src/lib/domain/queue";
import "./invoices.css";

type DocumentVersion = { id: string; name: string; kind: "image" | "pdf"; original: string; preview: string; at: string; actor: string; replacedAt?: string; removedAt?: string };
type Entry = { current?: DocumentVersion; history: DocumentVersion[]; log: QueueRevision[] };
type Store = Record<string, Entry>;
const date = (value: string) => new Date(value).toLocaleString("pt-BR");
function pdfData(plate: string) {
  const stream = `BT /F1 18 Tf 50 760 Td (NOTA DE DEMONSTRACAO - SEM VALOR FISCAL) Tj 0 -40 Td (Placa: ${plate}) Tj ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((obj, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return `data:application/pdf;base64,${btoa(pdf)}`;
}
function fixture(plate: string, kind: "image" | "pdf", actor: string): DocumentVersion {
  const canvas = document.createElement("canvas"); canvas.width = 1000; canvas.height = 1150;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, 1000, 1150); ctx.fillStyle = "#243936";
  ctx.font = "bold 32px sans-serif"; ctx.fillText("NOTA FISCAL — DEMONSTRAÇÃO", 50, 80);
  ctx.font = "22px sans-serif";
  ["SEM VALOR FISCAL · DADOS FICTÍCIOS", `Placa: ${plate}`, "Emitente: Empresa de exemplo", "Número: 000000 · Série: 000", "Produto: Glicerina de demonstração", "Usina de origem: Usina de exemplo", "Este documento serve apenas para testar a tela.", "Não representa uma nota fiscal real."].forEach((line,i)=>{ctx.fillText(line,50,160+i*105);ctx.fillStyle="#dbe4e0";ctx.fillRect(50,190+i*105,900,1);ctx.fillStyle="#243936";});
  const originalImage = canvas.toDataURL("image/png");
  const small = document.createElement("canvas"); small.width = 650; small.height = 748; small.getContext("2d")!.drawImage(canvas,0,0,650,748);
  return { id: crypto.randomUUID(), name: `nota-demo-${plate}.${kind === "pdf" ? "pdf" : "png"}`, kind, original: kind === "pdf" ? pdfData(plate) : originalImage, preview: small.toDataURL("image/jpeg",0.82), at: new Date().toISOString(), actor };
}
function initialStore(): Store {
  return Object.fromEntries(["ABC1D23","DEF4G56","GHI7J89","JKL1M23","MNO4P56","PQR7S89"].map((plate,i)=>[`demo-${i+1}`,{ current: i === 3 ? undefined : fixture(plate,"image","Motorista de demonstração"), history: [], log: i === 3 ? [{id:"demo-4-document-pending",action:"Check-in com documento pendente",actor:"Sistema",at:"2026-09-10T10:10:00-03:00",fields:["Exceção após duas tentativas malsucedidas."]}] : [] }]));
}
export function useDemoInvoices(role: string) {
  const [store, setStore] = useState<Store>(initialStore);
  const actor = role === "admin" ? "Admin Line" : role === "supervisor" ? "Supervisor Line" : "Analista Line";
  const isInternal = ["line","admin","supervisor"].includes(role);
  function save(id: string, plate: string, kind: "image" | "pdf", expectedId?: string) {
    if (!isInternal) throw new Error("Cliente não pode acessar notas fiscais.");
    const next = fixture(plate,kind,actor);
    const eventId = crypto.randomUUID();
    setStore(previous => {
      const entry = previous[id];
      if (entry.current?.id !== expectedId) return previous;
      const revision: QueueRevision = {
        id: eventId,
        action: entry.current ? "Nota fiscal substituída" : "Nota fiscal anexada",
        actor,
        at: next.at,
        fields: entry.current ? [`${entry.current.name} → ${next.name}`] : [next.name],
      };
      return {...previous, [id]: {
        current: next,
        history: entry.current ? [{...entry.current, replacedAt: next.at}, ...entry.history] : entry.history,
        log: [revision, ...entry.log],
      }};
    });
  }
  function remove(id: string, versionId: string) {
    if (!["admin","supervisor"].includes(role)) return;
    const eventId = crypto.randomUUID();
    const at = new Date().toISOString();
    setStore(previous => {
      const entry = previous[id];
      const currentMatch = entry.current?.id === versionId;
      const target = currentMatch ? entry.current : entry.history.find(v => v.id === versionId);
      if (!target) return previous;
      const revision: QueueRevision = {
        id: eventId, action: "Nota fiscal excluída", actor, at,
        fields: [`${target.name} (${currentMatch ? 'atual' : 'anterior'})`, "Registro textual preservado."],
      };
      return {...previous, [id]: {
        current: currentMatch ? undefined : entry.current,
        history: entry.history.filter(v => v.id !== versionId),
        log: [revision, ...entry.log],
      }};
    });
  }
  return {
    withHistory: (visit: QueueVisit): QueueVisit => {
      const documentEvents = isInternal ? store[visit.id]?.log : undefined;
      if (!documentEvents?.length) return visit;
      // Both internal views read the same events; draft/version state remains unchanged.
      const revisions = [...(visit.revisions ?? []), ...documentEvents]
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      const latest = revisions[0];
      return {...visit, revisions, ...(Date.parse(latest.at) > Date.parse(visit.updatedAtIso)
        ? {updatedAtIso: latest.at, updatedBy: latest.actor} : {})};
    },
    hasDocument: (id: string) => Boolean(store[id]?.current),
    reset: () => setStore(initialStore()),
    render: (visit: QueueVisit) => isInternal ? <InvoicePanel key={visit.id} visit={visit} entry={store[visit.id]} canDelete={["admin","supervisor"].includes(role)} onSave={(kind,expected)=>save(visit.id,visit.plate,kind,expected)} onRemove={(id)=>remove(visit.id,id)} /> : null,
    marker: (visit: QueueVisit) => isInternal ? <small className={`q-pending-label ${store[visit.id]?.current?'nf-received':''}`}>{store[visit.id]?.current?'Nota fiscal recebida':'Nota fiscal pendente'}</small> : null,
  };
}
function AnalysisDialog({visit, entry, close, canDelete, onRemove}: {visit:QueueVisit;entry:Entry;close:()=>void;canDelete:boolean;onRemove:(id:string)=>void}) {
  const ref=useRef<HTMLDialogElement>(null);
  const returnFocus=useRef<HTMLElement | null>(null);
  const [selectedId,setSelectedId]=useState(entry.current?.id);
  const [original,setOriginal]=useState(false);
  const selected=[entry.current,...entry.history].find(v=>v?.id===selectedId);
  useEffect(()=>{const dialog=ref.current!;returnFocus.current=document.activeElement instanceof HTMLElement ? document.activeElement : null;dialog.showModal();return()=>{dialog.close();returnFocus.current?.focus();};},[]);
  return <dialog ref={ref} className="nf-dialog" aria-label="Análise da nota fiscal" onCancel={close}><div className="nf-dialog-heading"><div><span className="q-eyebrow">{visit.publicCode} · {visit.plate}</span><h2>Análise da nota fiscal</h2></div><button onClick={close}>Voltar à fila</button></div><div className="nf-analysis-layout"><div className="nf-analysis-document">{selected ? <>{selected.kind==='pdf'&&original?<iframe title="PDF original de demonstração" src={selected.original} />:<img src={original?selected.original:selected.preview} alt={`Documento fictício da visita ${visit.publicCode}`} />}<p className="q-help">{selected.kind==='pdf'&&!original?'Representação do PDF fictício; use Ver original para abrir o PDF.':original?'Arquivo original de demonstração.':'Versão otimizada do documento fictício.'}</p></>:<p>Arquivo excluído. O registro textual da alteração foi preservado.</p>}</div><aside><strong>{selected?.name || 'Documento indisponível'}</strong>{selected&&<><p className="q-help">{selected.actor} · {date(selected.at)}</p><div className="nf-actions"><button onClick={()=>setOriginal(!original)}>{original?'Ver versão otimizada':'Ver original'}</button><a className="nf-button" href={selected.original} download={selected.name}>Baixar original</a></div>{canDelete&&<DeleteDocument document={selected} visit={visit} onRemove={()=>onRemove(selected.id)} />}</>}<h3>Documentos da visita</h3>{entry.current&&<button className="nf-version" onClick={()=>{setSelectedId(entry.current!.id);setOriginal(false);}}>Atual · {entry.current.name}</button>}{entry.history.map(v=><button className="nf-version" key={v.id} onClick={()=>{setSelectedId(v.id);setOriginal(false);}}>Anterior · {v.name}<small>Disponível até {new Date(new Date(v.replacedAt!).getTime()+90*86400000).toLocaleDateString('pt-BR')}</small></button>)}<p className="q-help">Atual: 12 meses após conclusão/cancelamento. Substituído: 90 dias após a troca. Expiração automática não executada nesta simulação.</p><h3>Registro das alterações</h3>{entry.log.length?entry.log.map(event=><p className="q-help" key={event.id}><strong>{event.action}</strong><br />{date(event.at)} · {event.actor}<br />{event.fields.join(", ")}</p>):<p className="q-help">Nenhuma alteração nesta demonstração.</p>}</aside></div></dialog>;
}
function DeleteDocument({document,visit,onRemove}:{document:DocumentVersion;visit:QueueVisit;onRemove:()=>void}) {
  const [confirm,setConfirm]=useState(false);
  return confirm?<div className="nf-warning"><p>Excluir {document.name} da visita {visit.publicCode}, placa {visit.plate}? A visita e o registro textual serão mantidos.</p><div className="nf-actions"><button onClick={()=>setConfirm(false)}>Cancelar exclusão</button><button onClick={()=>{onRemove();setConfirm(false);}}>Confirmar exclusão</button></div></div>:<button className="nf-delete" onClick={()=>setConfirm(true)}>Excluir arquivo…</button>;
}
function InvoicePanel({visit,entry,canDelete,onSave,onRemove}:{visit:QueueVisit;entry:Entry;canDelete:boolean;onSave:(kind:"image"|"pdf",expectedId?:string)=>void;onRemove:(id:string)=>void}) {
  const [analysis,setAnalysis]=useState(false);
  const [upload,setUpload]=useState(false);
  const [kind,setKind]=useState<"image"|"pdf">("image");
  const [fail,setFail]=useState(false);
  const [message,setMessage]=useState("");
  const expectedId=useRef<string|undefined>(undefined);
  function openUpload(){expectedId.current=entry.current?.id;setUpload(true);setMessage('');}
  function save(){if(fail){setMessage('Falha simulada no envio. O documento anterior e o status da visita foram mantidos.');return;}if(expectedId.current!==entry.current?.id){setMessage('Documento alterado. Feche e reabra o envio para conferir a versão atual.');return;}onSave(kind,expectedId.current);setUpload(false);setMessage('Documento salvo nesta simulação. A liberação continua uma ação separada da Line.');}
  return <section className="q-section nf-section" aria-label="Nota fiscal da visita"><h3>Nota fiscal <span>Somente Line</span></h3>{entry.current?<div className="nf-card"><strong>{entry.current.name}</strong><p className="q-help">Documento recebido · {entry.current.actor}</p><details className="nf-inline-preview"><summary>Visualizar nota</summary><img src={entry.current.preview} alt={`Prévia fictícia da nota da visita ${visit.publicCode}`} /><p className="q-help">{entry.current.kind==='pdf'?'Representação do PDF fictício; abra a análise para conferir o original.':'Versão otimizada para leitura diária. Imagem fictícia.'}</p></details><div className="nf-actions"><button onClick={(e)=>{e.currentTarget.focus();setAnalysis(true);}}>Analisar nota ↗</button><a className="nf-button" href={entry.current.original} download={entry.current.name}>Baixar original</a><button onClick={openUpload}>Substituir documento</button></div>{canDelete&&<DeleteDocument document={entry.current} visit={visit} onRemove={()=>onRemove(entry.current!.id)} />}</div>:<div className="nf-warning"><strong>Documento pendente</strong><p>Obtenha a nota com o motorista e anexe à visita. Sem documento, a liberação para chamada fica bloqueada.</p><button onClick={openUpload}>Anexar foto ou PDF</button></div>}{upload&&<div className="nf-upload"><strong>{entry.current?'Substituir documento':'Anexar documento'} · simulação</strong><label>Arquivo de demonstração<select value={kind} onChange={e=>setKind(e.target.value as "image"|"pdf")}><option value="image">Foto fictícia (PNG)</option><option value="pdf">PDF fictício</option></select></label><label className="nf-failure"><input type="checkbox" checked={fail} onChange={e=>setFail(e.target.checked)} />Simular falha no envio do documento</label><div className="nf-actions"><button className="q-primary" onClick={save}>Simular envio</button><button onClick={()=>setUpload(false)}>Cancelar envio</button></div><p className="q-help">Usa somente arquivos gerados nesta página. Nada é enviado para serviços externos.</p></div>}{message&&<p className="q-notice" role="status">{message}</p>}{!entry.current&&(entry.history.length>0||entry.log.length>0)&&<button className="q-link" onClick={(e)=>{e.currentTarget.focus();setAnalysis(true);}}>Histórico dos documentos</button>}<p className="q-help">Anexar não libera automaticamente nem resolve outras pendências. Downloads contêm somente exemplos fictícios.</p>{analysis&&<AnalysisDialog visit={visit} entry={entry} close={()=>setAnalysis(false)} canDelete={canDelete} onRemove={onRemove} />}</section>;
}
