import { describe, expect, it } from "vitest";
import {
  canAccessCheckins,
  canManageCheckins,
  filterCheckins,
  statusLabel
} from "@/app/(app)/checkins/checkins-ui";
import type { InternalCheckinListItem } from "@/app/(app)/checkins/checkins-ui";

function checkin(
  input: Partial<InternalCheckinListItem> = {}
): InternalCheckinListItem {
  return {
    id: "checkin-1",
    plate: "ABC1D23",
    driverName: "Maria da Silva",
    carrierName: "Line Transportes",
    product: "Óleo vegetal",
    clientId: null,
    clientName: null,
    status: "AGUARDANDO_LIBERACAO",
    version: 1,
    ...input
  };
}

describe("check-ins UI policy", () => {
  it("exposes the queue to operational roles but never to DISPLAY", () => {
    expect(canAccessCheckins("OPERATOR")).toBe(true);
    expect(canAccessCheckins("SUPERVISOR")).toBe(true);
    expect(canAccessCheckins("ADMIN")).toBe(true);
    expect(canAccessCheckins("DISPLAY")).toBe(false);
  });

  it("reserves corrections and operational decisions for managers", () => {
    expect(canManageCheckins("OPERATOR")).toBe(false);
    expect(canManageCheckins("SUPERVISOR")).toBe(true);
    expect(canManageCheckins("ADMIN")).toBe(true);
    expect(canManageCheckins("DISPLAY")).toBe(false);
  });
});

describe("check-ins queue presentation", () => {
  it("uses the approved Portuguese labels for every queue state", () => {
    expect(statusLabel("PRE_CADASTRO")).toBe("Pré-cadastro");
    expect(statusLabel("AGUARDANDO_LIBERACAO")).toBe("Aguardando liberação");
    expect(statusLabel("AGUARDANDO_CHAMADA")).toBe("Aguardando chamada");
    expect(statusLabel("CHAMADO")).toBe("Chamado");
    expect(statusLabel("EM_DESCARGA")).toBe("Em descarga");
    expect(statusLabel("CONCLUIDO")).toBe("Concluído");
    expect(statusLabel("CANCELADO")).toBe("Cancelado");
  });

  it("filters by status and a case-insensitive operational search", () => {
    const rows = [
      checkin(),
      checkin({
        id: "checkin-2",
        plate: "DEF4G56",
        driverName: "João Pereira",
        carrierName: "Baixada Cargas",
        clientName: "Cliente B",
        status: "CHAMADO"
      })
    ];

    expect(filterCheckins(rows, { query: "baixada", status: "" })).toEqual([
      rows[1]
    ]);
    expect(
      filterCheckins(rows, { query: "def4g56", status: "CHAMADO" })
    ).toEqual([rows[1]]);
    expect(
      filterCheckins(rows, {
        query: "cliente b",
        status: "AGUARDANDO_LIBERACAO"
      })
    ).toEqual([]);
  });
});
