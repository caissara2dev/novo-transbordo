import { describe, expect, it } from "vitest";
import { applyQueueCommand, assertSharedFieldLimits, driverCallWhatsapp, queueMatchesSearch, type QueueVisit } from "@/lib/domain/queue";
const visit = {
  id: "visit", plate: "ABC-1D23", driverName: "Motorista Demo", publicCode: "DEMO-01", booking: "BK TESTE",
  sample: "", observation: "", product: "Glicerina", clientName: "ALLOG", clientId: "allog", status: "AGUARDANDO_LIBERACAO",
  issues: [{ id: "old", description: "Conferir nota", resolved: false }],
} as QueueVisit;
const clients = [{ id: "allog", name: "ALLOG", portalEnabled: true, usesSample: true }];
describe("queue policy", () => {
  it.each(["ABC1D23", "abc-1d23", " ABC 1D23 ", "abc", "BK TESTE", "motorista demo", "glicerina"])("finds %s without changing non-plate search", (query) => {
    expect(queueMatchesSearch(visit, query)).toBe(true);
  });
  it("does not match another plate", () => expect(queueMatchesSearch(visit, "XYZ1D23")).toBe(false));
  it("keeps legacy oversized values only while unchanged", () => {
    const before = { booking: "b".repeat(101), sample: "s".repeat(101), observation: "o".repeat(301) };
    expect(() => assertSharedFieldLimits(before, before)).not.toThrow();
    for (const field of ["booking", "sample", "observation"] as const)
      expect(() => assertSharedFieldLimits(before, { ...before, [field]: `x${before[field].slice(1)}` })).toThrow(/caracteres/);
    expect(() => assertSharedFieldLimits(before, { booking: "b".repeat(100), sample: "s".repeat(100), observation: "o".repeat(300) })).not.toThrow();
  });
  it("changes one issue at a time, never by classification", () => {
    const added = applyQueueCommand(visit, { kind: "ISSUE_ADD", issue: { id: "new", description: "  Outra nota  " } }, clients);
    expect(added.issues).toEqual([...visit.issues!, { id: "new", description: "Outra nota", resolved: false }]);
    const resolved = applyQueueCommand(added, { kind: "ISSUE_SET_STATE", issueId: "new", resolved: true }, clients);
    expect(resolved.issues![1].resolved).toBe(true);
    const reopened = applyQueueCommand(resolved, { kind: "ISSUE_SET_STATE", issueId: "new", resolved: false }, clients);
    expect(reopened.issues![1].resolved).toBe(false);
    const classified = applyQueueCommand(reopened, { kind: "CLASSIFY", clientId: "allog", shared: { booking: "new", sample: "OK", observation: "" } }, clients);
    expect(classified.issues).toEqual(reopened.issues);
    const deleted = applyQueueCommand(classified, { kind: "ISSUE_DELETE", issueId: "new" }, clients);
    expect(deleted.issues).toEqual(visit.issues);
    expect(() => applyQueueCommand(visit, { kind: "ISSUE_ADD", issue: { id: "old", description: "Duplicada" } }, clients)).toThrow(/registrada/);
    expect(() => applyQueueCommand(visit, { kind: "ISSUE_DELETE", issueId: "missing" }, clients)).toThrow(/encontrada/);
    expect(() => applyQueueCommand(visit, { kind: "ISSUE_ADD", issue: { id: "empty", description: " " } }, clients)).toThrow(/Descreva/);
  });
  it("does not permit customer issue commands", () => {
    expect(() => applyQueueCommand(visit, { kind: "ISSUE_DELETE", issueId: "old" }, clients, clients[0])).toThrow(/não pode/);
  });
  it("opens only a conversation with the approved message and valid Brazilian phone", () => {
    const result = driverCallWhatsapp({ ...visit, driverPhone: "+55 (13) 99652-4561" });
    const url = new URL(result!);
    expect(url.origin + url.pathname).toBe("https://wa.me/5513996524561");
    expect(url.searchParams.get("text")).toBe("Olá, Motorista Demo. Aqui é da Line Transportes. O veículo ABC-1D23 foi chamado. Por favor, apresente-se à equipe da Line para receber as orientações de descarga.");
    expect(driverCallWhatsapp({ ...visit, driverPhone: "13996524561" })).toBe(result);
    expect(driverCallWhatsapp({ ...visit, driverPhone: "1323456789" })).toContain("551323456789");
    expect(driverCallWhatsapp({ ...visit, driverPhone: "00000000000" })).toBeNull();
    expect(driverCallWhatsapp(visit)).toBeNull();
  });
});
