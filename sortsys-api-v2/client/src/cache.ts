export function isInBrowser() {
  try {
    return typeof window === 'object';
  } catch (_) {
    return false;
  }
}

export interface Cache {
  getBytes(key: string): Promise<Uint8Array | null>;
  setBytes(key: string, bytes: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  keys(): Promise<Set<string>>;
}

/** The default reply cache owns its bytes and never persists them in the browser. */
export function createCache(maxEntries = 200, maxBytes = 8 * 1024 * 1024): Cache {
  if (
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 0 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0
  ) {
    throw new RangeError("Invalid reply cache limits");
  }

  const entries = new Map<string, Uint8Array>();
  let size = 0;

  function remove(key: string) {
    const bytes = entries.get(key);
    if (!bytes) return;

    entries.delete(key);
    size -= bytes.byteLength;
    bytes.fill(0);
  }

  return {
    async getBytes(key) {
      const bytes = entries.get(key);
      if (!bytes) return null;

      entries.delete(key);
      entries.set(key, bytes);
      return new Uint8Array(bytes);
    },

    async setBytes(key, bytes) {
      remove(key);
      if (maxEntries === 0 || bytes.byteLength > maxBytes) return;

      const copy = new Uint8Array(bytes);
      entries.set(key, copy);
      size += copy.byteLength;

      for (const key of entries.keys()) {
        if (entries.size <= maxEntries && size <= maxBytes) break;
        remove(key);
      }
    },

    async delete(key) {
      remove(key);
    },

    async clear() {
      for (const bytes of entries.values()) bytes.fill(0);
      entries.clear();
      size = 0;
    },

    async keys() {
      return new Set(entries.keys());
    },
  };
}

