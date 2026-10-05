/** A least-recently-used map bounded by an approximate byte budget. */
export class ByteCache<V> {
  private entries = new Map<string, {value: V; bytes: number}>();
  private used = 0;

  get bytes() {
    return this.used;
  }

  get size() {
    return this.entries.size;
  }

  /** Returns the value and marks it as recently used. */
  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /** Stores a value, evicting the oldest entries until the budget fits. Oversized values are not stored. */
  set(key: string, value: V, bytes: number, budget: number) {
    this.delete(key);
    if (bytes > budget) return false;
    this.entries.set(key, {value, bytes});
    this.used += bytes;
    while (this.used > budget) this.delete(this.entries.keys().next().value!);
    return true;
  }

  delete(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.used -= entry.bytes;
  }

  clear() {
    this.entries.clear();
    this.used = 0;
  }
}
