import { KVDB } from './kvdb';
import { LRUMap } from './lrumap';

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

export function createCache(): Cache {
  const toBuffer = (u8: Uint8Array): ArrayBuffer | SharedArrayBuffer =>
    u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

  const fromBuffer = (v: ArrayBuffer | SharedArrayBuffer): Uint8Array =>
    new Uint8Array(v);

  if (!isInBrowser() || !("indexedDB" in globalThis)) {
    const store = new LRUMap<string, Uint8Array>(500);

    return {
      async getBytes(key) {
        const v = store.get(key);
        return v ? new Uint8Array(v) : null;
      },
      async setBytes(key, bytes) {
        store.set(key, new Uint8Array(bytes));
      },
      async delete(key) {
        store.delete(key);
      },
      async clear() {
        store.clear();
      },
      async keys() {
        return new Set(store.keys());
      },
    };
  }

  let kv: KVDB | null = null;
  try {
    kv = new KVDB("sortsys-v2-cache");
  } catch {
    throw new Error('failed to create cache');
  }

  type DBEntry = {
    value: ArrayBuffer | SharedArrayBuffer;
    exp: number; // epoch ms; 0 = no expiry
  };


  return {
    async getBytes(key) {
      const entry = await kv!.get(key);
      if (!entry) return null;

      if (entry.exp !== 0 && entry.exp <= Date.now()) {
        await kv!.del(key);
        return null;
      }

      return fromBuffer(entry.value);
    },

    async setBytes(key, bytes) {
      const entry: DBEntry = {
        value: toBuffer(bytes),
        exp: Date.now() + 3 * 24 * 3600 * 1000, // 3 days
      };

      try {
        await kv!.set(key, entry);
      } catch {
        /* best-effort: ignore */
      }
    },

    async delete(key) {
      try {
        await kv!.del(key);
      } catch { }
    },

    async clear() {
      try {
        await kv!.clear();
      } catch { }
    },

    async keys() {
      try {
        return await kv!.keys();
      } catch {
        return new Set();
      }
    },
  };
}

