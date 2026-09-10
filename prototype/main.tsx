import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueueWorkspace } from "../src/components/queue/workspace";
import {
  applyQueueCommand,
  publicCustomerVisit,
  queueCsv,
} from "../src/lib/domain/queue";
import type {
  QueueClient,
  QueueVisit,
  QueueCommand,
} from "../src/lib/domain/queue";
import "./prototype.css";
const clients: QueueClient[] = [
  { id: "allog", name: "ALLOG", portalEnabled: true, usesSample: true },
  {
    id: "cliente-demo",
    name: "Cliente Horizonte · demonstração",
    portalEnabled: true,
    usesSample: false,
  },
  {
    id: "sem-acesso",
    name: "Cliente Aurora · demonstração",
    portalEnabled: false,
    usesSample: true,
  },
];
function fixtures(): QueueVisit[] {
  const base: QueueVisit = {
    id: "demo-1",
    publicCode: "DEMO-01",
    plate: "ABC1D23",
    driverName: "Motorista de demonstração 1",
    carrierName: "Transportadora Exemplo",
    product: "Glicerina bruta",
    originPlant: "Usina Exemplo",
    originInvoiceNumbers: "NF-DEMO-001",
    remittanceInvoiceNumber: "REM-DEMO-001",
    vehicleType: "Bitrem",
    clientId: null,
    clientName: null,
    status: "AGUARDANDO_LIBERACAO",
    version: 1,
    booking: "",
    sample: "OK",
    observation: "",
    usesSample: true,
    confirmedAtIso: "2026-09-10T10:10:00-03:00",
    updatedAtIso: "2026-09-10T10:10:00-03:00",
    updatedBy: "Sistema",
    issues: [
      {
        id: "doc",
        description: "Conferir nota fiscal de remessa",
        resolved: false,
      },
    ],
    revisions: [],
    location: {
      latitude: -23.927722,
      longitude: -46.375806,
      accuracyMeters: 25,
      capturedAtIso: "2026-09-10T10:10:00-03:00",
    },
  };
  return [
    base,
    {
      ...structuredClone(base),
      id: "demo-2",
      publicCode: "DEMO-02",
      plate: "DEF4G56",
      driverName: "Motorista de demonstração 2",
      clientId: "allog",
      clientName: "ALLOG",
      status: "AGUARDANDO_CHAMADA",
      booking: "BK-DEMO-02",
      issues: [],
    },
    {
      ...structuredClone(base),
      id: "demo-3",
      publicCode: "DEMO-03",
      plate: "GHI7J89",
      driverName: "Motorista de demonstração 3",
      clientId: "allog",
      clientName: "ALLOG",
      status: "CHAMADO",
      booking: "BK-DEMO-03",
      issues: [],
    },
    {
      ...structuredClone(base),
      id: "demo-4",
      publicCode: "DEMO-04",
      plate: "JKL1M23",
      driverName: "Motorista de demonstração 4",
      clientId: "sem-acesso",
      clientName: clients[2].name,
      sample: "Em análise",
    },
    {
      ...structuredClone(base),
      id: "demo-5",
      publicCode: "DEMO-05",
      plate: "MNO4P56",
      driverName: "Motorista de demonstração 5",
      clientId: "cliente-demo",
      clientName: clients[1].name,
      usesSample: false,
      sample: "",
      issues: [],
    },
    {
      ...structuredClone(base),
      id: "demo-6",
      publicCode: "DEMO-06",
      plate: "PQR7S89",
      driverName: "Motorista de demonstração 6",
      clientId: "allog",
      clientName: "ALLOG",
      status: "CONCLUIDO",
      booking: "BK-DEMO-06",
      issues: [],
    },
  ];
}
function Demo() {
  const database = useRef(fixtures());
  const [snapshot, setSnapshot] = useState(fixtures);
  const [role, setRole] = useState("line");
  const [failEvent, setFailEvent] = useState(false);
  const [failExport, setFailExport] = useState(false);
  const [eventId, setEventId] = useState("demo-3");
  const [note, setNote] = useState("");
  const customer = clients.find((c) => c.id === role);
  function refresh() {
    setSnapshot(structuredClone(database.current));
  }
  async function command(id: string, version: number, action: QueueCommand) {
    const before = database.current.find((v) => v.id === id)!;
    if (before.version !== version)
      throw new Error(
        "Outra pessoa alterou esta visita. Seu preenchimento foi mantido. Use Atualizar para carregar a versão atual e reaplicar sua alteração.",
      );
    const updated = applyQueueCommand(before, action, clients, customer);
    const now = new Date().toISOString();
    database.current = database.current.map((v) =>
      v.id !== id
        ? v
        : {
            ...updated,
            version: v.version + 1,
            updatedAtIso: now,
            updatedBy: customer ? `Cliente ${customer.name}` : "Analista Line",
            revisions: [
              {
                id: crypto.randomUUID(),
                action:
                  action.kind === "TRANSITION"
                    ? "Status alterado"
                    : "Informações atualizadas",
                actor: customer ? customer.name : "Analista Line",
                at: now,
                fields:
                  action.kind === "SHARED"
                    ? ["Booking", "Amostra", "Observação"]
                    : [action.kind],
              },
              ...(v.revisions ?? []),
            ],
          },
    );
    refresh();
  }
  async function exportData(visits: QueueVisit[]) {
    if (failExport)
      throw new Error(
        "Exportação indisponível nesta simulação. A fila e o check-in continuam funcionando.",
      );
    const url = URL.createObjectURL(
      new Blob([queueCsv(visits)], { type: "text/csv;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "fila-demonstracao.csv";
    a.click();
    URL.revokeObjectURL(url);
  }
  function saveEvent() {
    const visit = database.current.find((v) => v.id === eventId);
    if (!visit || visit.status !== "CHAMADO") {
      setNote("Selecione uma visita chamada.");
      return;
    }
    if (visit.issues?.some((i) => !i.resolved)) {
      setNote("Há pendências em aberto nesta visita.");
      return;
    }
    if (failEvent) {
      setNote(
        "Falha simulada: lançamento não foi salvo. A visita permanece CHAMADO.",
      );
      return;
    }
    database.current = database.current.map((v) =>
      v.id === eventId
        ? {
            ...v,
            status: "EM_DESCARGA",
            version: v.version + 1,
            updatedBy: "Operador de demonstração",
            updatedAtIso: new Date().toISOString(),
          }
        : v,
    );
    refresh();
    setNote("Lançamento salvo e vinculado. A visita entrou em descarga.");
  }
  return (
    <>
      <header className="demo-chrome">
        <div className="demo-brand">
          <span>LINE</span>
          <div>
            Controle Transbordo<small>Protótipo · dados fictícios</small>
          </div>
        </div>
        <label>
          Visualizar como
          <select
            aria-label="Visualizar como"
            value={role}
            onChange={(e) => {
              setRole(e.target.value);
              refresh();
              setNote("");
            }}
          >
            <option value="line">Analista Line</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {!c.portalEnabled ? " · sem acesso" : ""}
              </option>
            ))}
          </select>
        </label>
      </header>
      {customer && !customer.portalEnabled ? (
        <main className="demo-no-access">
          <h1>Acesso não habilitado</h1>
          <p>
            Este cliente não participa do portal. A equipe Line preenche as
            informações da carga.
          </p>
        </main>
      ) : (
        <QueueWorkspace
          key={role}
          visits={
            customer
              ? snapshot
                  .filter((v) => v.clientId === customer.id)
                  .map(publicCustomerVisit)
              : snapshot
          }
          clients={customer ? [customer] : clients}
          customer={customer}
          onCommand={command}
          onRefresh={async () => refresh()}
          onExport={exportData}
        />
      )}
      <details className="demo-tools">
        <summary>Experimentar situações do fluxo</summary>
        <div>
          <button
            onClick={() => {
              database.current = database.current.map((v) => ({
                ...v,
                version: v.version + 1,
                updatedBy: "Outro analista",
              }));
              setNote(
                "Alteração concorrente simulada. Tente salvar um preenchimento em aberto para ver o aviso.",
              );
            }}
          >
            Simular alteração por outra pessoa
          </button>
          <button
            onClick={() => {
              database.current = fixtures();
              refresh();
              setNote("Demonstração reiniciada.");
            }}
          >
            Reiniciar demonstração
          </button>
          <label>
            <input
              type="checkbox"
              checked={failExport}
              onChange={(e) => setFailExport(e.target.checked)}
            />
            Simular falha na exportação
          </label>
        </div>
        <fieldset>
          <legend>Seleção pelo operador</legend>
          <label>
            Visita chamada
            <select
              value={eventId}
              onChange={(e) => setEventId(e.target.value)}
            >
              {snapshot
                .filter((v) => v.status === "CHAMADO")
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.publicCode} · {v.plate}
                  </option>
                ))}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={failEvent}
              onChange={(e) => setFailEvent(e.target.checked)}
            />
            Simular falha ao salvar
          </label>
          <button onClick={saveEvent}>Salvar lançamento simulado</button>
        </fieldset>
        <p role="status">{note}</p>
      </details>
      <footer className="demo-footer">
        Check-in não garante posição ou ordem de descarga. Nenhuma conexão com
        planilhas ou produção.
      </footer>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Demo />);
