const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function encodeKey(key: string): string {
  const bytes = textEncoder.encode(key);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function decodeKey(encoded: string): string {
  const bin = atob(encoded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return textDecoder.decode(bytes);
}


type DBEntry = {
  value: ArrayBuffer | SharedArrayBuffer;
  exp: number; // epoch ms; 0 = no expiry
};


type IDBMode = IDBTransactionMode;

export class KVDB {
  private db!: IDBDatabase;
  private initP: Promise<void>;

  constructor(
    private readonly dbName: string,
    private readonly storeName = "kv",
    private readonly version = 1,
  ) {
    this.initP = this.open();
  }

  private async open(): Promise<void> {
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, this.version);

      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
      };

      req.onsuccess = () => {
        req.result.onversionchange = () => req.result.close();
        resolve(req.result);
      };

      req.onerror = () => reject(req.error);
    });
  }

  private async withTx<T>(
    mode: IDBMode,
    fn: (store: IDBObjectStore) => IDBRequest<T> | void,
  ): Promise<T> {
    await this.initP;

    return new Promise<T>((resolve, reject) => {
      const tx = this.db.transaction(this.storeName, mode);
      const store = tx.objectStore(this.storeName);

      let req: IDBRequest<T> | undefined;
      try {
        req = fn(store) as any;
      } catch (e) {
        tx.abort();
        reject(e);
        return;
      }

      let result!: T;
      if (req) {
        req.onsuccess = () => (result = req.result as T);
        req.onerror = () => reject(req.error);
      }

      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async get(key: string): Promise<DBEntry | null> {
    const encoded = encodeKey(key);
    const v = await this.withTx<DBEntry | undefined>(
      "readonly",
      s => s.get(encoded),
    );
    return v ?? null;
  }

  async set(key: string, entry: DBEntry): Promise<void> {
    const encoded = encodeKey(key);
    await this.withTx("readwrite", s => s.put(entry, encoded));
  }

  async del(key: string): Promise<void> {
    const encoded = encodeKey(key);
    await this.withTx("readwrite", s => s.delete(encoded));
  }

  async clear(): Promise<void> {
    await this.withTx("readwrite", s => s.clear());
  }

  async keys(): Promise<Set<string>> {
    const keys = await this.withTx<IDBValidKey[]>(
      "readonly",
      s => s.getAllKeys(),
    );
    const out = new Set<string>();
    for (const k of keys) {
      if (typeof k !== "string") continue;
      try {
        out.add(decodeKey(k));
      } catch {
        /* skip */
      }
    }
    return out;
  }
}

