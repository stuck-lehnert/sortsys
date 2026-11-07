export type Recovery = {
  base: string;
  source: string;
  updatedAt: number;
  fileName?: string;
  drafts?: Array<[string, string]>;
};
const database = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("sortsys-gaeb-recovery", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("documents");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
export async function recovery<T extends "get" | "put" | "delete">(
  action: T,
  key: string,
  value?: Recovery,
): Promise<Recovery | undefined> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(
        "documents",
        action === "get" ? "readonly" : "readwrite",
      );
      const store = transaction.objectStore("documents");
      const request =
        action === "get"
          ? store.get(key)
          : action === "put"
            ? store.put(value, key)
            : store.delete(key);
      transaction.oncomplete = () =>
        resolve(action === "get" ? request.result : undefined);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}
