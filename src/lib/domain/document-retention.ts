/** Document retention uses calendar months in UTC, not a fixed number of days. */
export function documentDeadline(closedAtIso: string): string {
  const closed = new Date(closedAtIso);
  if (!Number.isFinite(closed.getTime())) throw new Error("Data de encerramento inválida.");
  const year = closed.getUTCFullYear() + 1;
  const month = closed.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  closed.setUTCDate(Math.min(closed.getUTCDate(), lastDay));
  closed.setUTCFullYear(year);
  return closed.toISOString();
}

export function documentHasExpired(
  visit: { documentExpiresAtIso?: string | null },
  now = Date.now(),
): boolean {
  if (!visit.documentExpiresAtIso) return false;
  const deadline = Date.parse(visit.documentExpiresAtIso);
  return Number.isFinite(deadline) && deadline <= now;
}
