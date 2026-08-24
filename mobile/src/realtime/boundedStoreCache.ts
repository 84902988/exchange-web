export interface BoundedStoreCacheEntry {
  destroy(): void;
  isRetained(): boolean;
}

/**
 * Keeps recently used realtime stores without ever evicting an entry that is
 * still subscribed or owned by a mounted screen.
 */
export class BoundedStoreCache<
  Key,
  Entry extends BoundedStoreCacheEntry,
> {
  private readonly entries = new Map<Key, Entry>();

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('Bounded store cache limit must be a positive integer');
    }
  }

  getOrCreate(key: Key, create: () => Entry) {
    const existing = this.entries.get(key);
    if (existing) {
      this.touch(key, existing);
      this.trim(key);
      return existing;
    }

    const entry = create();
    this.entries.set(key, entry);
    this.trim(key);
    return entry;
  }

  clear() {
    for (const entry of this.entries.values()) entry.destroy();
    this.entries.clear();
  }

  sizeForTests() {
    return this.entries.size;
  }

  private touch(key: Key, entry: Entry) {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private trim(protectedKey: Key) {
    if (this.entries.size <= this.limit) return;

    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.limit) return;
      if (Object.is(key, protectedKey) || entry.isRetained()) continue;
      entry.destroy();
      this.entries.delete(key);
    }
  }
}
