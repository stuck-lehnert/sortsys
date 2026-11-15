import * as Y from "yjs";
import { diffChars } from "diff";

export class InvalidSharedUpdate extends Error {
  constructor() {
    super("invalid-shared-update");
    this.name = "InvalidSharedUpdate";
  }
}

export type TextEdit = { at: number; remove: number; insert: string };

/** Return a checked copy. Rejected packets must never leave pending Yjs
 * structs, embedded values or unexpected root types in the editor's state. */
export function checkedSharedUpdate(source: Y.Doc, update: Uint8Array): Y.Doc {
  const checked = new Y.Doc();
  try {
    Y.applyUpdate(checked, Y.encodeStateAsUpdate(source));
    Y.applyUpdate(checked, update);
    if (
      checked.share.size > 25_000 ||
      checked.store.clients.size > 4096 ||
      checked.store.pendingStructs !== null ||
      checked.store.pendingDs !== null
    ) {
      throw new InvalidSharedUpdate();
    }

    const fields = checked.getMap("__fields");
    if (fields.size > 25_000) {
      throw new InvalidSharedUpdate();
    }
    let fieldNameCharacters = 0;
    for (const [field, initialized] of fields) {
      if (
        !field ||
        field === "__fields" ||
        field.length > 4096 ||
        initialized !== true
      ) {
        throw new InvalidSharedUpdate();
      }
      fieldNameCharacters += field.length;
    }
    if (fieldNameCharacters > 4 * 1024 * 1024) {
      throw new InvalidSharedUpdate();
    }
    let structures = 0;
    for (const clientStructures of checked.store.clients.values()) {
      structures += clientStructures.length;
    }
    if (structures > 2_000_000) {
      throw new InvalidSharedUpdate();
    }

    let characters = 0;
    for (const key of checked.share.keys()) {
      if (key === "__fields") {
        continue;
      }
      if (!key || key.length > 4096 || fields.get(key) !== true) {
        throw new InvalidSharedUpdate();
      }
      const text = checked.getText(key);
      if (text.length > 2 * 1024 * 1024) {
        throw new InvalidSharedUpdate();
      }
      for (const part of text.toDelta()) {
        if (
          typeof part.insert !== "string" ||
          (part.attributes && Object.keys(part.attributes).length > 0)
        ) {
          throw new InvalidSharedUpdate();
        }
      }
      characters += text.length;
    }
    if (characters > 16 * 1024 * 1024) {
      throw new InvalidSharedUpdate();
    }
    return checked;
  } catch {
    checked.destroy();
    throw new InvalidSharedUpdate();
  }
}

/** An initializer must describe exactly one complete field. Its declared
 * baseline and its Yjs text must agree before it can win the ordered log. */
export function checkFieldInitialization(
  key: string,
  value: string,
  update: Uint8Array,
) {
  if (
    !key ||
    key === "__fields" ||
    key.length > 4096 ||
    value.length > 2 * 1024 * 1024
  ) {
    throw new InvalidSharedUpdate();
  }
  const empty = new Y.Doc();
  let initialized: Y.Doc | undefined;
  try {
    initialized = checkedSharedUpdate(empty, update);
    const fields = initialized.getMap("__fields");
    if (
      fields.size !== 1 ||
      fields.get(key) !== true ||
      [...initialized.share.keys()].some(
        (name) => name !== "__fields" && name !== key,
      ) ||
      initialized.getText(key).toString() !== value
    ) {
      throw new InvalidSharedUpdate();
    }
  } finally {
    initialized?.destroy();
    empty.destroy();
  }
}

/** Plan queued local input before committing any remote state. A failed
 * three-way merge retains both the previous text and the pending input. */
export function pendingTextEdits(
  baseline: string,
  pending: string,
  current: string,
): TextEdit[] {
  if (current === pending || pending === baseline) {
    return [];
  }
  const changes = diffChars(baseline, pending, { timeout: 50 });
  const mapping = diffChars(baseline, current, { timeout: 50 });
  if (!changes || !mapping) {
    throw new Error("merge-conflict");
  }

  function currentOffset(index: number) {
    let source = 0;
    let target = 0;
    for (const part of mapping!) {
      if (part.added) {
        target += part.value.length;
      } else if (index <= source + part.value.length) {
        return target + (part.removed ? 0 : index - source);
      } else {
        source += part.value.length;
        if (!part.removed) {
          target += part.value.length;
        }
      }
    }
    return target;
  }

  let source = 0;
  const edits: TextEdit[] = [];
  for (const part of changes) {
    if (part.added) {
      edits.push({ at: currentOffset(source), remove: 0, insert: part.value });
    } else if (part.removed) {
      edits.push({
        at: currentOffset(source),
        remove:
          currentOffset(source + part.value.length) - currentOffset(source),
        insert: "",
      });
      source += part.value.length;
    } else {
      source += part.value.length;
    }
  }
  return edits.reverse();
}
