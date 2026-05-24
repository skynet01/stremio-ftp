export const SHARED_INDEX_DEFAULT_SCAN_INTERVAL_MINUTES = 12 * 60;

export function nextAlignedScanAt(intervalMinutes: number, now: Date = new Date()): string | null {
  if (intervalMinutes <= 0) return null;
  const intervalMs = intervalMinutes * 60_000;
  const nextMs = Math.ceil((now.getTime() + 1) / intervalMs) * intervalMs;
  return new Date(nextMs).toISOString();
}
