"use client";

import { useEffect, useMemo, useState } from "react";
import type { DriverCheckinForm } from "@/lib/domain/checkins";
import { closedVisit, queueLabels } from "@/lib/domain/queue";
import type {
  QueueClient,
  QueueCommand,
  QueueIssue,
  QueueVisit,
} from "@/lib/domain/queue";
import "./workspace.css";

type Props = {
  visits: QueueVisit[];
  clients: QueueClient[];
  customer?: QueueClient;
  onCommand: (
    id: string,
    version: number,
    command: QueueCommand,
  ) => Promise<void>;
  onInspect?: (id: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onExport: (visits: QueueVisit[]) => Promise<void>;
};
const date = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
function Badge({ visit }: { visit: QueueVisit }) {
  return (
    <span className={`q-badge q-state-${visit.status}`}>
      {queueLabels[visit.status]}
    </span>
  );
}

function VisitEditor({
  visit,
  clients,
  customer,
  onCommand,
}: Pick<Props, "clients" | "customer" | "onCommand"> & { visit: QueueVisit }) {
  const [clientId, setClientId] = useState(visit.clientId ?? "");
  const [shared, setShared] = useState({
    booking: visit.booking,
    sample: visit.sample,
    observation: visit.observation,
  });
  const [issues, setIssues] = useState<QueueIssue[]>(visit.issues ?? []);
  const [newIssue, setNewIssue] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [showLocation, setShowLocation] = useState(false);
  const [correction, setCorrection] = useState<Partial<DriverCheckinForm>>({
    driverName: visit.driverName,
    plate: visit.plate,
    carrierName: visit.carrierName,
    product: visit.product,
    originPlant: visit.originPlant,
    vehicleType: visit.vehicleType,
    originInvoiceNumbers: visit.originInvoiceNumbers,
    remittanceInvoiceNumber: visit.remittanceInvoiceNumber,
    ...(visit.driverLicense ? { driverLicense: visit.driverLicense } : {}),
    ...(visit.driverPhone ? { driverPhone: visit.driverPhone } : {}),
  });
  const [reason, setReason] = useState("");
  const readOnly = Boolean(customer && closedVisit(visit.status));
  const client = clients.find((item) => item.id === clientId);
  const dirty =
    clientId !== (visit.clientId ?? "") ||
    JSON.stringify(shared) !==
      JSON.stringify({
        booking: visit.booking,
        sample: visit.sample,
        observation: visit.observation,
      }) ||
    JSON.stringify(issues) !== JSON.stringify(visit.issues ?? []);
  const openIssues = issues.filter((issue) => !issue.resolved).length;
  async function run(command: QueueCommand) {
    setPending(true);
    setError("");
    setMessage("");
    try {
      await onCommand(visit.id, visit.version, command);
      setMessage("Alterações salvas.");
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Não foi possível salvar. Seu preenchimento foi mantido.",
      );
    } finally {
      setPending(false);
    }
  }
  const save = () =>
    run(
      customer
        ? { kind: "SHARED", shared }
        : { kind: "CLASSIFY", clientId, shared, issues },
    );
  return (
    <section
      className="q-detail"
      aria-label="Detalhes da visita"
      aria-busy={pending}
    >
      <header className="q-detail-heading">
        <div>
          <span className="q-eyebrow">{visit.publicCode}</span>
          <h2>{visit.plate}</h2>
          <p>{visit.driverName}</p>
        </div>
        <Badge visit={visit} />
      </header>
      <div className="q-detail-body">
        {!customer && (
          <section className="q-section">
            <h3>Classificação</h3>
            <label>
              Cliente
              <select
                aria-label="Cliente da visita"
                value={clientId}
                onChange={(e) => {
                  setClientId(e.target.value);
                  if (visit.clientId && e.target.value !== visit.clientId)
                    setShared({ booking: "", sample: "", observation: "" });
                }}
                disabled={pending || visit.status !== "AGUARDANDO_LIBERACAO"}
              >
                <option value="">Selecione o cliente</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <p className="q-help">
              {visit.clientId && visit.clientId !== clientId
                ? "A troca de cliente limpa os campos compartilhados. O histórico permanece interno."
                : client
                  ? client.portalEnabled
                    ? "Cliente com acesso às próprias cargas."
                    : "Preenchimento pela Line · cliente sem acesso ao portal."
                  : "Atribua um cliente para disponibilizar a carga e preparar a liberação."}
            </p>
          </section>
        )}
        <section className="q-section">
          <h3>
            Dados da viagem <span>Recebidos no check-in</span>
          </h3>
          <dl className="q-facts">
            {[
              ["Transportadora", visit.carrierName],
              ["Produto", visit.product],
              ["Usina", visit.originPlant],
              ["Veículo", visit.vehicleType],
              ["NF de usina", visit.originInvoiceNumbers],
              ["NF de remessa", visit.remittanceInvoiceNumber],
              ["Check-in", date(visit.confirmedAtIso)],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value || "—"}</dd>
              </div>
            ))}
          </dl>
          {!customer && (
            <>
              <div className="q-inline-actions">
                <button
                  type="button"
                  className="q-link"
                  onClick={() => setShowLocation(!showLocation)}
                >
                  Localização do check-in
                </button>
              </div>
              {showLocation && (
                <div className="q-location">
                  {visit.location ? (
                    <>
                      <strong>
                        Ponto capturado às {date(visit.location.capturedAtIso)}
                      </strong>
                      <p>
                        {visit.location.latitude.toFixed(6)},{" "}
                        {visit.location.longitude.toFixed(6)} · precisão de{" "}
                        {visit.location.accuracyMeters} m
                      </p>
                      <a
                        target="_blank"
                        rel="noreferrer"
                        href={`https://www.google.com/maps/search/?api=1&query=${visit.location.latitude},${visit.location.longitude}`}
                      >
                        Abrir ponto no mapa ↗
                      </a>
                      <p>
                        Localização capturada no check-in. Não é rastreamento em
                        tempo real.
                      </p>
                    </>
                  ) : (
                    "Ponto exato indisponível nesta visita."
                  )}
                </div>
              )}
              <details className="q-correction">
                <summary>Conferir / corrigir dados</summary>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run({ kind: "CORRECT", patch: correction, reason });
                  }}
                >
                  <div className="q-fields">
                    {(
                      Object.keys(correction) as Array<keyof DriverCheckinForm>
                    ).map((key) => (
                      <label key={key}>
                        {
                          (
                            {
                              driverName: "Motorista",
                              driverLicense: "CNH",
                              driverPhone: "Telefone",
                              plate: "Placa",
                              carrierName: "Transportadora",
                              product: "Produto",
                              originPlant: "Usina",
                              originInvoiceNumbers: "NF de usina",
                              remittanceInvoiceNumber: "NF de remessa",
                              vehicleType: "Veículo",
                            } as Record<string, string>
                          )[key]
                        }
                        {key === "vehicleType" ? (
                          <select
                            value={String(correction[key])}
                            onChange={(e) =>
                              setCorrection({
                                ...correction,
                                vehicleType: e.target
                                  .value as DriverCheckinForm["vehicleType"],
                              })
                            }
                          >
                            {["Bitrem", "Rodotrem", "Vanderleia"].map((v) => (
                              <option key={v}>{v}</option>
                            ))}
                          </select>
                        ) : (
                          <input
                            required
                            value={String(correction[key] ?? "")}
                            onChange={(e) =>
                              setCorrection({
                                ...correction,
                                [key]: e.target.value,
                              })
                            }
                          />
                        )}
                      </label>
                    ))}
                  </div>
                  <label>
                    Motivo da correção
                    <textarea
                      aria-label="Motivo da correção"
                      required
                      maxLength={500}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </label>
                  <button disabled={pending || dirty} type="submit">
                    Salvar correção
                  </button>
                  {dirty && (
                    <p className="q-help">
                      Salve a classificação antes de corrigir os dados.
                    </p>
                  )}
                </form>
              </details>
            </>
          )}
        </section>
        <section className="q-section">
          <h3>Informações compartilhadas</h3>
          <fieldset disabled={readOnly || pending} className="q-fields">
            <label>
              Booking
              <input
                maxLength={1000}
                value={shared.booking}
                onChange={(e) =>
                  setShared({ ...shared, booking: e.target.value })
                }
                placeholder="Informe o booking"
              />
            </label>
            {(!customer || customer.usesSample) && (
              <label>
                Amostra
                <input
                  maxLength={500}
                  value={shared.sample}
                  onChange={(e) =>
                    setShared({ ...shared, sample: e.target.value })
                  }
                  placeholder={
                    client?.usesSample === false
                      ? "Não utilizada neste processo"
                      : "Ex.: OK"
                  }
                />
              </label>
            )}
            <label className="q-wide">
              Observação
              <textarea
                aria-label="Observação"
                maxLength={2000}
                rows={3}
                value={shared.observation}
                onChange={(e) =>
                  setShared({ ...shared, observation: e.target.value })
                }
                placeholder="Informações sobre esta carga"
              />
            </label>
          </fieldset>
          {(!customer || customer.usesSample) && (
            <p className="q-help">
              Amostra “OK” indica aprovação da amostra. A liberação é uma
              decisão da Line.
            </p>
          )}
          {readOnly && (
            <p className="q-notice">
              Visita encerrada. Para correções, entre em contato com a Line.
            </p>
          )}
        </section>
        {!customer && (
          <section className="q-section">
            <h3>
              Pendências internas <span>{openIssues} em aberto</span>
            </h3>
            <div className="q-issues">
              {issues.map((issue) => (
                <label
                  key={issue.id}
                  className={`q-issue ${issue.resolved ? "q-resolved" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={issue.resolved}
                    onChange={(e) =>
                      setIssues(
                        issues.map((item) =>
                          item.id === issue.id
                            ? { ...item, resolved: e.target.checked }
                            : item,
                        ),
                      )
                    }
                  />
                  <span>{issue.description}</span>
                  <small>{issue.resolved ? "Resolvida" : "Em aberto"}</small>
                </label>
              ))}
              {!issues.length && (
                <p className="q-help">Nenhuma pendência registrada.</p>
              )}
            </div>
            <form
              className="q-add-issue"
              onSubmit={(e) => {
                e.preventDefault();
                if (newIssue.trim()) {
                  setIssues([
                    ...issues,
                    {
                      id: crypto.randomUUID(),
                      description: newIssue.trim(),
                      resolved: false,
                    },
                  ]);
                  setNewIssue("");
                }
              }}
            >
              <input
                aria-label="Nova pendência"
                maxLength={500}
                value={newIssue}
                onChange={(e) => setNewIssue(e.target.value)}
                placeholder="Descreva a pendência"
              />
              <button type="submit" disabled={!newIssue.trim() || pending}>
                Adicionar
              </button>
            </form>
          </section>
        )}
        {error && (
          <p className="q-error" role="alert">
            {error}
          </p>
        )}
        {message && (
          <p className="q-notice" role="status">
            {message}
          </p>
        )}
        <div className="q-savebar">
          {!readOnly && (
            <button
              className="q-primary"
              disabled={pending || !dirty}
              onClick={() => void save()}
            >
              {pending ? "Salvando…" : "Salvar alterações"}
            </button>
          )}
          {!customer && visit.status === "AGUARDANDO_LIBERACAO" && (
            <button
              disabled={pending || dirty || !visit.clientId || openIssues > 0}
              onClick={() =>
                void run({ kind: "TRANSITION", toStatus: "AGUARDANDO_CHAMADA" })
              }
            >
              Liberar para chamada
            </button>
          )}
          {!customer && visit.status === "AGUARDANDO_CHAMADA" && (
            <button
              disabled={pending || dirty || openIssues > 0}
              onClick={() =>
                void run({ kind: "TRANSITION", toStatus: "CHAMADO" })
              }
            >
              Chamar motorista
            </button>
          )}
          {!customer && visit.status === "EM_DESCARGA" && (
            <button
              disabled={pending || dirty}
              onClick={() =>
                void run({ kind: "TRANSITION", toStatus: "CONCLUIDO" })
              }
            >
              Concluir visita
            </button>
          )}
        </div>
        {dirty && (
          <p className="q-help">
            Há alterações para salvar. Salvar não libera nem chama a visita.
          </p>
        )}
        {visit.status === "CHAMADO" && (
          <p className="q-notice">
            {customer
              ? "Aguardando o início da operação pela Line."
              : "A entrada em descarga será registrada quando o operador salvar o lançamento vinculado."}
          </p>
        )}
        <p className="q-last">
          Última alteração: {visit.updatedBy || "Sistema"} ·{" "}
          {date(visit.updatedAtIso)}
        </p>
        {!customer && (
          <details className="q-history">
            <summary>Histórico de alterações</summary>
            {visit.revisions?.length ? (
              visit.revisions.map((revision) => (
                <article key={revision.id}>
                  <strong>{revision.action}</strong>
                  <p>
                    {revision.actor} · {date(revision.at)}
                  </p>
                  <small>{revision.fields.join(", ")}</small>
                </article>
              ))
            ) : (
              <p className="q-help">
                O histórico aparecerá após as alterações.
              </p>
            )}
          </details>
        )}
      </div>
    </section>
  );
}

export function QueueWorkspace({
  visits,
  clients,
  customer,
  onCommand,
  onRefresh,
  onExport,
  onInspect,
}: Props) {
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState("ACTIVE");
  const [clientFilter, setClientFilter] = useState("");
  const [status, setStatus] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const filtered = useMemo(
    () =>
      visits.filter((v) => {
        const text = [
          v.plate,
          v.driverName,
          v.publicCode,
          v.booking,
          v.clientName,
          v.product,
        ]
          .join(" ")
          .toLocaleLowerCase("pt-BR");
        return (
          text.includes(query.trim().toLocaleLowerCase("pt-BR")) &&
          (!clientFilter || v.clientId === clientFilter) &&
          (!status || v.status === status) &&
          (tab === "HISTORY"
            ? closedVisit(v.status)
            : tab === "UNASSIGNED"
              ? !v.clientId && !closedVisit(v.status)
              : tab === "ACTIVE"
                ? !closedVisit(v.status) && v.status !== "PRE_CADASTRO"
                : v.status === tab)
        );
      }),
    [visits, query, clientFilter, status, tab],
  );
  const selected = filtered.find((v) => v.id === selectedId) ?? filtered[0];
  useEffect(() => {
    if (selected?.id && onInspect)
      void onInspect(selected.id).catch((e) =>
        setError(
          e instanceof Error ? e.message : "Falha ao carregar detalhes.",
        ),
      );
  }, [selected?.id, onInspect]);
  const tabs = customer
    ? [
        ["ACTIVE", "Em andamento"],
        ["HISTORY", "Histórico"],
      ]
    : [
        ["ACTIVE", "Todas ativas"],
        ["UNASSIGNED", "Sem cliente"],
        ["AGUARDANDO_LIBERACAO", "Em análise"],
        ["AGUARDANDO_CHAMADA", "Liberadas"],
        ["CHAMADO", "Chamadas"],
        ["HISTORY", "Histórico"],
      ];
  async function refresh() {
    setRefreshing(true);
    setError("");
    try {
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível atualizar.");
    } finally {
      setRefreshing(false);
    }
  }
  return (
    <main className={`queue-workspace ${customer ? "q-customer" : ""}`}>
      <header className="q-page-heading">
        <div>
          <p className="q-eyebrow">
            LINE TRANSPORTES / {customer ? customer.name : "OPERAÇÃO"}
          </p>
          <h1>{customer ? "Minhas cargas" : "Fila de check-ins"}</h1>
          <p>
            {customer
              ? "Acompanhe suas cargas e atualize as informações."
              : "Classifique as chegadas e prepare a próxima chamada."}
          </p>
        </div>
        <div className="q-heading-actions">
          <button onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? "Atualizando…" : "Atualizar"}
          </button>
          <button
            onClick={() => {
              setError("");
              void onExport(filtered).catch((e) =>
                setError(
                  e instanceof Error
                    ? e.message
                    : "Exportação indisponível. A fila continua disponível.",
                ),
              );
            }}
          >
            Exportar CSV ↓
          </button>
        </div>
      </header>
      <nav className="q-tabs" aria-label="Etapas da fila">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            aria-pressed={tab === id}
            onClick={() => {
              setTab(id);
              setSelectedId(null);
            }}
          >
            {label}
          </button>
        ))}
      </nav>
      <section className="q-toolbar" aria-label="Filtros">
        <label className="q-search">
          Buscar
          <input
            type="search"
            placeholder={
              customer ? "Placa ou booking" : "Placa, motorista ou booking"
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {!customer && (
          <label>
            Cliente
            <select
              value={clientFilter}
              onChange={(e) => setClientFilter(e.target.value)}
            >
              <option value="">Todos os clientes</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Todos os status</option>
            {Object.entries(queueLabels)
              .filter(([s]) => s !== "PRE_CADASTRO")
              .map(([s, label]) => (
                <option key={s} value={s}>
                  {label}
                </option>
              ))}
          </select>
        </label>
        <span className="q-count">
          {filtered.length} {filtered.length === 1 ? "visita" : "visitas"}
        </span>
      </section>
      {error && (
        <p className="q-error" role="alert">
          {error}
        </p>
      )}
      {customer && (
        <div className="q-table-wrap">
          <table>
            <thead>
              <tr>
                {[
                  "Visita / placa",
                  "Produto / usina",
                  "Booking",
                  "Amostra",
                  "Status",
                ]
                  .filter((t) => customer.usesSample || t !== "Amostra")
                  .map((t) => (
                    <th key={t}>{t}</th>
                  ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((v) => (
                <tr
                  key={v.id}
                  className={selected?.id === v.id ? "q-selected-row" : ""}
                >
                  <td>
                    <button
                      className="q-link"
                      onClick={() => setSelectedId(v.id)}
                    >
                      {v.plate}
                    </button>
                    <small>{v.publicCode}</small>
                  </td>
                  <td>
                    {v.product}
                    <small>{v.originPlant}</small>
                  </td>
                  <td>{v.booking || "—"}</td>
                  {customer.usesSample && <td>{v.sample || "—"}</td>}
                  <td>
                    <Badge visit={v} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="q-workbench">
        {!customer && (
          <section className="q-list" aria-label="Visitas">
            {filtered.map((v) => (
              <button
                key={v.id}
                className={`q-visit ${selected?.id === v.id ? "q-selected" : ""}`}
                onClick={() => setSelectedId(v.id)}
              >
                <span className="q-visit-meta">
                  {v.publicCode}
                  <span>{date(v.confirmedAtIso)}</span>
                </span>
                <strong>{v.plate}</strong>
                <span>{v.driverName}</span>
                <p>
                  {v.product} · {v.originPlant}
                </p>
                <div className="q-visit-footer">
                  <span className={!v.clientId ? "q-unassigned" : ""}>
                    {v.clientName || "Sem cliente"}
                  </span>
                  <Badge visit={v} />
                </div>
                {(v.issues?.filter((i) => !i.resolved).length ?? 0) > 0 && (
                  <small className="q-pending-label">
                    ● Pendência em aberto
                  </small>
                )}
              </button>
            ))}
          </section>
        )}
        {selected ? (
          <VisitEditor
            key={`${customer?.id ?? "line"}:${selected.id}:${selected.version}`}
            visit={selected}
            clients={clients}
            customer={customer}
            onCommand={onCommand}
          />
        ) : (
          <section className="q-empty">
            <h2>Nenhuma visita nesta seleção</h2>
            <p>Altere os filtros para consultar outras cargas.</p>
          </section>
        )}
      </div>
    </main>
  );
}
