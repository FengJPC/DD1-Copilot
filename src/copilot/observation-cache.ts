/** Forget old inspection attempts; action receipts use a separate durable store. */
export class ObservationCache {
  private readonly keys = new Set<string>();
  constructor(private readonly capacity = 256) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Observation cache capacity must be positive.');
  }
  has(key: string) { return this.keys.has(key); }
  add(key: string) {
    this.keys.delete(key);
    this.keys.add(key);
    if (this.keys.size > this.capacity) this.keys.delete(this.keys.values().next().value!);
  }
  clear() { this.keys.clear(); }
}
