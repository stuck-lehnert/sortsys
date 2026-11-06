import type { GaebDocument } from "./document";
export type GaebPositionSuggestion = {
  id: string;
  shortText: string;
  description: string;
  unit: string;
  sourceFile: string;
};
export type GaebPositionSearch = (
  query: string,
) => Promise<{ items: GaebPositionSuggestion[]; indexing: boolean }>;
const cache = new Map<
  string,
  { scope: string; items: GaebPositionSuggestion[] }
>();
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("sortsys-gaeb-positions", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("documents", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function rememberPositions(scope: string, model: GaebDocument) {
  const items = model.items
    .map((entry) => ({
      ...model.positionText(entry),
      id: entry.key,
      sourceFile: model.fileName,
    }))
    .filter((item) => item.shortText && item.shortText !== "…");
  for (const item of items)
    cache.set(JSON.stringify([scope, model.fileName, item.id]), {
      scope,
      items: [item],
    });
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("documents", "readwrite");
      for (const item of items)
        tx.objectStore("documents").put({
          id: JSON.stringify([scope, model.fileName, item.id]),
          scope,
          items: [item],
        });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
export async function searchPositions(scope: string, query: string) {
  let documents: Array<{ scope: string; items: GaebPositionSuggestion[] }> = [];
  try {
    const db = await database();
    try {
      documents = await new Promise((resolve, reject) => {
        const request = db
          .transaction("documents")
          .objectStore("documents")
          .getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  } catch {
    documents = [...cache.values()];
  }
  const words = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const unique = new Map<string, GaebPositionSuggestion>();
  for (const doc of documents.filter((doc) => doc.scope === scope))
    for (const item of doc.items) {
      const key = JSON.stringify([item.shortText, item.description, item.unit]);
      if (
        words.every((word) =>
          (item.shortText + " " + item.description)
            .toLocaleLowerCase()
            .includes(word),
        )
      )
        unique.set(key, { ...item, id: key });
    }
  return { items: [...unique.values()].slice(0, 20), indexing: false };
}
