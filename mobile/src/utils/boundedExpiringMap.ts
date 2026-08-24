type ExpiringEntry = {
  expiresAt: number;
};

export function getFreshExpiringEntry<K, V extends ExpiringEntry>(
  cache: Map<K, V>,
  key: K,
  now = Date.now(),
) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    cache.delete(key);
    return undefined;
  }

  // Touch the key so capacity eviction follows recent use instead of insertion order.
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

export function setBoundedExpiringEntry<K, V extends ExpiringEntry>(
  cache: Map<K, V>,
  key: K,
  entry: V,
  maxEntries: number,
  now = Date.now(),
) {
  const capacity = Math.max(1, Math.trunc(maxEntries));
  cache.forEach((candidate, candidateKey) => {
    if (candidate.expiresAt <= now) cache.delete(candidateKey);
  });

  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > capacity) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

export function getOrCreateInFlightRequest<K, V>(
  requests: Map<K, Promise<V>>,
  key: K,
  load: () => Promise<V>,
) {
  const existing = requests.get(key);
  if (existing) return existing;

  let loaded: Promise<V>;
  try {
    loaded = load();
  } catch (error) {
    loaded = Promise.reject(error);
  }
  let request!: Promise<V>;
  request = loaded.finally(() => {
    if (requests.get(key) === request) requests.delete(key);
  });
  requests.set(key, request);
  return request;
}
