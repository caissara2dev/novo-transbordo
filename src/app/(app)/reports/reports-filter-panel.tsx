import {
  containerStatusOptions,
  pumpOptions,
  reportCategoryOptions,
  shiftOptions
} from "@/lib/domain/options";
import { ReportGranularity } from "@/types/api";
import { numberFmt } from "./report-formatters";
import { ReportsDashboard } from "./use-reports-dashboard";

type ReportsFilterPanelProps = ReportsDashboard["filters"];

export function ReportsFilterPanel({
  draftFilters,
  selectedPreset,
  clients,
  isAdmin,
  loading,
  limits,
  updateDraftFilters,
  updateCustomDate,
  applyPreset,
  applyFilters
}: ReportsFilterPanelProps) {
  return (
    <section className="panel reports-filter-panel">
      <div className="reports-preset-row">
        <button
          aria-pressed={selectedPreset === "today"}
          className={`btn-soft reports-preset-btn ${selectedPreset === "today" ? "active" : ""}`}
          onClick={() => applyPreset("today")}
          type="button"
        >
          Hoje
        </button>
        <button
          aria-pressed={selectedPreset === "week"}
          className={`btn-soft reports-preset-btn ${selectedPreset === "week" ? "active" : ""}`}
          onClick={() => applyPreset("week")}
          type="button"
        >
          Semana atual
        </button>
        <button
          aria-pressed={selectedPreset === "month"}
          className={`btn-soft reports-preset-btn ${selectedPreset === "month" ? "active" : ""}`}
          onClick={() => applyPreset("month")}
          type="button"
        >
          Mês atual
        </button>
        <button
          aria-pressed={selectedPreset === "last7"}
          className={`btn-soft reports-preset-btn ${selectedPreset === "last7" ? "active" : ""}`}
          onClick={() => applyPreset("last7")}
          type="button"
        >
          Últimos 7 dias
        </button>
        {selectedPreset === "custom" ? (
          <span className="reports-custom-chip">Personalizado</span>
        ) : null}
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <label className="field-label">
          Data de
          <input
            className="input-ui"
            onChange={(event) =>
              updateCustomDate("dateFrom", event.target.value)
            }
            type="date"
            value={draftFilters.dateFrom}
          />
        </label>
        <label className="field-label">
          Data até
          <input
            className="input-ui"
            onChange={(event) => updateCustomDate("dateTo", event.target.value)}
            type="date"
            value={draftFilters.dateTo}
          />
        </label>
        <label className="field-label">
          Granularidade
          <select
            className="select-ui"
            onChange={(event) =>
              updateDraftFilters({
                granularity: event.target.value as ReportGranularity
              })
            }
            value={draftFilters.granularity}
          >
            <option value="day">Dia</option>
            <option value="week">Semana</option>
            <option value="month">Mês</option>
          </select>
        </label>
        <label className="field-label">
          Bomba
          <select
            className="select-ui"
            onChange={(event) =>
              updateDraftFilters({ pump: event.target.value })
            }
            value={draftFilters.pump}
          >
            <option value="">Todas</option>
            {pumpOptions.map((pump) => (
              <option key={pump.value} value={pump.value}>
                {pump.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field-label">
          Turno
          <select
            className="select-ui"
            onChange={(event) =>
              updateDraftFilters({ shiftType: event.target.value })
            }
            value={draftFilters.shiftType}
          >
            <option value="">Todos</option>
            {shiftOptions.map((shift) => (
              <option key={shift.value} value={shift.value}>
                {shift.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field-label">
          Categoria
          <select
            className="select-ui"
            onChange={(event) =>
              updateDraftFilters({ category: event.target.value })
            }
            value={draftFilters.category}
          >
            <option value="">Todas</option>
            {reportCategoryOptions.map((category) => (
              <option key={category.value} value={category.value}>
                {category.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field-label">
          Cliente
          <select
            className="select-ui"
            onChange={(event) =>
              updateDraftFilters({ clientId: event.target.value })
            }
            value={draftFilters.clientId}
          >
            <option value="">Todos</option>
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field-label">
          Estado do container
          <select
            className="select-ui"
            onChange={(event) =>
              updateDraftFilters({ containerStatus: event.target.value })
            }
            value={draftFilters.containerStatus}
          >
            <option value="">Todos</option>
            {containerStatusOptions.map((status) => (
              <option key={status.value} value={status.value}>
                {status.label}
              </option>
            ))}
          </select>
        </label>

        <div className="reports-filter-actions">
          {isAdmin ? (
            <label className="reports-toggle muted">
              <input
                checked={draftFilters.includeDeleted}
                onChange={(event) =>
                  updateDraftFilters({ includeDeleted: event.target.checked })
                }
                type="checkbox"
              />
              Incluir excluídos
            </label>
          ) : null}
          <button
            className="btn-primary"
            disabled={loading}
            onClick={applyFilters}
            type="button"
          >
            {loading ? "Aplicando..." : "Aplicar filtros"}
          </button>
        </div>
      </div>

      {limits ? (
        <p className="mt-2 text-xs muted">
          Limites: até {limits.maxPeriodDays} dias e{" "}
          {numberFmt.format(limits.maxEventsProcessed)} eventos por consulta.
        </p>
      ) : null}
    </section>
  );
}
