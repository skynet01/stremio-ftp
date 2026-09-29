export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(private readonly maxEntries: number) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.expiresAt <= Date.now()) return undefined;
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, ttlMs: number) {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    for (const oldestKey of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(oldestKey);
    }
  }

  clear() {
    this.entries.clear();
  }

  get size() {
    return this.entries.size;
  }
}
