import { describe, expect, it } from "vitest";
import { buildDisplayOverview } from "@/lib/server/display-overview";

describe("display overview", () => {
  it("counts full, blend full and legacy productive events as separate finalizations", () => {
    const result = buildDisplayOverview({
      operationalDate: "2026-07-23",
      generatedAt: "2026-07-24T03:20:00.000Z",
      events: [
        {
          category: "PRODUTIVO",
          productive: true,
          deleted: false,
          durationMinutes: 20,
          container: "A",
          containerStatus: "FULL",
          clientId: "a",
          clientNameSnapshot: "Alfa"
        },
        {
          category: "PRODUTIVO",
          productive: true,
          deleted: false,
          durationMinutes: 40,
          container: "B",
          containerStatus: "BLEND_FULL",
          clientId: "a",
          clientNameSnapshot: "Alfa"
        },
        {
          category: "PRODUTIVO",
          productive: true,
          deleted: false,
          durationMinutes: 30,
          container: "A",
          clientId: "a",
          clientNameSnapshot: "Alfa"
        },
        {
          category: "PRODUTIVO",
          productive: true,
          deleted: false,
          durationMinutes: 10,
          container: "C",
          containerStatus: "PARTIAL",
          clientId: "b",
          clientNameSnapshot: "Beta"
        },
        {
          category: "PRODUTIVO",
          productive: true,
          deleted: true,
          durationMinutes: 200,
          container: "D",
          containerStatus: "FULL",
          clientId: "b",
          clientNameSnapshot: "Beta"
        },
        {
          category: "MANUTENCAO",
          productive: false,
          deleted: false,
          durationMinutes: 100,
          clientId: "b",
          clientNameSnapshot: "Beta"
        }
      ],
      containerStates: []
    });

    expect(result.finalizedTotal).toBe(3);
    expect(result.averageProductiveMinutes).toBe(25);
    expect(result.clients).toEqual([
      expect.objectContaining({
        clientName: "Alfa",
        finalizedToday: 3,
        openNow: 0
      })
    ]);
  });

  it("splits current open states and orders clients by finalized, open and name", () => {
    const result = buildDisplayOverview({
      operationalDate: "2026-07-24",
      generatedAt: "2026-07-24T12:00:00.000Z",
      events: [
        {
          category: "PRODUTIVO",
          durationMinutes: 15,
          container: "A",
          containerStatus: "FULL",
          clientId: "z",
          clientNameSnapshot: "Zeta"
        },
        {
          category: "PRODUTIVO",
          durationMinutes: 25,
          container: "B",
          containerStatus: "FULL",
          clientId: "a",
          clientNameSnapshot: "Alfa"
        }
      ],
      containerStates: [
        { status: "PARTIAL", clientId: "z", clientNameSnapshot: "Zeta" },
        { status: "BUFFER", clientId: "a", clientNameSnapshot: "Alfa" },
        { status: "BLEND_PARTIAL", clientId: "a", clientNameSnapshot: "Alfa" },
        { status: "FULL", clientId: "ignored", clientNameSnapshot: "Ignorado" },
        { status: "PARTIAL", clientId: "b", clientNameSnapshot: "Beta" }
      ]
    });

    expect(result.openContainers).toEqual({
      total: 4,
      partial: 2,
      buffer: 1,
      blendPartial: 1
    });
    expect(result.clients.map((client) => client.clientName)).toEqual([
      "Alfa",
      "Zeta",
      "Beta"
    ]);
  });

  it("returns an empty, stable state when there is no movement", () => {
    const result = buildDisplayOverview({
      operationalDate: "2026-07-24",
      generatedAt: "2026-07-24T12:00:00.000Z",
      events: [],
      containerStates: []
    });

    expect(result.finalizedTotal).toBe(0);
    expect(result.averageProductiveMinutes).toBeNull();
    expect(result.openContainers.total).toBe(0);
    expect(result.clients).toEqual([]);
  });
});
