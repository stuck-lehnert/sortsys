/** RPC responses stay in RAM. Decrypted business data must never enter the
 * SDK's legacy IndexedDB cache, including through a metadata stream. */
export function ramCache(maxEntries = 200, maxBytes = 8 * 1024 * 1024) {
  const entries = new Map<string, Uint8Array>();
  let size = 0;
  function remove(key: string) {
    const value = entries.get(key);
    if (value) { size -= value.byteLength; value.fill(0); entries.delete(key); }
  }
  return {
    async getBytes(key: string): Promise<Uint8Array | null> {
      const value = entries.get(key);
      if (!value) return null;
      entries.delete(key); entries.set(key, value);
      return value.slice();
    },
    async setBytes(key: string, value: Uint8Array): Promise<void> {
      remove(key);
      if (value.byteLength > maxBytes) return;
      const copy = value.slice(); entries.set(key, copy); size += copy.byteLength;
      while (entries.size > maxEntries || size > maxBytes) remove(entries.keys().next().value!);
    },
    async delete(key: string) { remove(key); },
    async clear() { for (const value of entries.values()) value.fill(0); entries.clear(); size = 0; },
    async keys() { return new Set(entries.keys()); },
  };
}
