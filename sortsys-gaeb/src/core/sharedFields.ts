import { measurementField } from "./takeoffLabels";
import * as Y from "yjs";
import { diffChars } from "diff";
import { GaebDocument } from "./document";
import type { Collaborator, EditorField } from "../canvas/types";

export type LiveSelection = {
  field: string | null;
  start?: number;
  end?: number;
  direction?: "forward" | "backward" | "none";
};
export type SharedFieldChange = {
  key: string;
  value: string;
  selection?: LiveSelection;
};
export const encodeUpdate = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
};
export const decodeUpdate = (value: string) =>
  Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

/** Only editable field text enters the CRDT. Native XML, formatting and unknown
 * extensions remain in the versioned file and its conservative structure merge. */
export class SharedFields {
  private doc = new Y.Doc();
  private undoManager = new Y.UndoManager(this.doc, {
    trackedOrigins: new Set(["local"]),
    captureTimeout: 500,
  });
  private fields = new Map<
    string,
    {
      baseline: string;
      pending?: string;
      known: Set<string>;
      protectNative?: boolean;
    }
  >();
  private native: GaebDocument | undefined;
  private listeners = new Set<(change: SharedFieldChange) => void>();
  private epoch: string | undefined;
  private online = false;
  private writable = false;
  private selection: LiveSelection = { field: null };
  private send: ((message: Record<string, unknown>) => void) | undefined;
  constructor() {
    this.observeUpdates();
  }
  private observeUpdates() {
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== "remote" && this.online && this.writable)
        this.send?.({ type: "update", data: encodeUpdate(update) });
    });
  }
  connect(
    send: (message: Record<string, unknown>) => void,
    writable: boolean,
    epoch?: string,
  ) {
    if (epoch !== undefined && this.epoch !== undefined && epoch !== this.epoch)
      this.newSession();
    if (epoch !== undefined) this.epoch = epoch;
    this.send = send;
    this.online = true;
    this.writable = writable;
    if (this.doc.store.clients.size && writable)
      send({
        type: "update",
        data: encodeUpdate(Y.encodeStateAsUpdate(this.doc)),
      });
    this.initialize();
  }
  private newSession() {
    this.online = false;
    // Carry text drafts, not identifiers from a room which no longer exists.
    // An unseen external replacement remains subject to the native merge.
    for (const [key, field] of this.fields) {
      const previous = this.value(key);
      const pending =
        field.pending ??
        (previous !== undefined && previous !== field.baseline
          ? previous
          : undefined);
      field.baseline = this.nativeValue(this.native, key) ?? field.baseline;
      field.pending =
        field.protectNative || pending === field.baseline ? undefined : pending;
      field.known = new Set([
        field.baseline,
        ...(field.pending === undefined ? [] : [field.pending]),
      ]);
    }
    this.undoManager.destroy();
    this.doc.destroy();
    this.doc = new Y.Doc();
    this.undoManager = new Y.UndoManager(this.doc, {
      trackedOrigins: new Set(["local"]),
      captureTimeout: 500,
    });
    this.observeUpdates();
  }
  disconnect() {
    this.online = false;
  }
  private has(key: string) {
    return this.doc.share.has(key) || this.doc.getMap("__fields").has(key);
  }
  value(key: string) {
    return this.has(key) ? this.doc.getText(key).toString() : undefined;
  }
  subscribe(listener: (change: SharedFieldChange) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  register(fields: Map<string, EditorField>) {
    let added = false;
    for (const field of fields.values()) {
      if (
        (!field.multiline &&
          !field.key.startsWith("meta:") &&
          !/:measure:[^:]+:(?:label|location)$/.test(field.key) &&
          field.key !== "takeoff:title" &&
          field.key !== "document:title" &&
          field.key !== "project:title" &&
          !field.key.includes(":heading:")) ||
        field.key.includes(":context:") ||
        this.fields.has(field.key)
      )
        continue;
      const baseline = this.nativeValue(this.native, field.key) ?? field.value;
      this.fields.set(field.key, {
        baseline,
        pending: field.value === baseline ? undefined : field.value,
        known: new Set([baseline, field.value]),
      });
      added = true;
    }
    if (added) this.initialize();
  }
  private initialize() {
    if (!this.online || !this.writable) return;
    const fields = [...this.fields]
      .filter(([key]) => !this.has(key))
      .map(([key, field]) => ({ key, value: field.baseline }));
    // Keep individual websocket messages bounded even for large specifications.
    for (const field of fields) this.send?.({ type: "initialize", ...field });
  }
  private nativeValue(
    model: GaebDocument | undefined,
    key: string,
  ): string | undefined {
    if (!model) return undefined;
    if (key === "takeoff:title") return model.takeoffTitle;
    if (key === "document:title") return model.documentTitle;
    if (key === "project:title") return model.projectName();
    const entry = model.entries.find((entry) =>
      key.startsWith(`${entry.key}:`),
    );
    if (entry) {
      if (key.startsWith(`${entry.key}:heading:`))
        return model
          .takeoff(entry)
          .headings.find(
            (row) => row.value.id === key.slice(entry.key.length + 9),
          )?.value.title;
      const measure = measurementField(key, entry.key);
      if (measure)
        return model
          .takeoff(entry)
          .rows.find((row) => row.value.id === measure.id)?.value[measure.name];
    }
    if (entry && key.slice(entry.key.length + 1).startsWith("text:"))
      return model.richGroups(entry)[Number(key.slice(entry.key.length + 6))]
        ?.text;
    if (key.startsWith("meta:"))
      return (
        model.metadataElements()[Number(key.slice(5))]?.textContent ?? undefined
      );
    return undefined;
  }
  private remember(key: string, value: string) {
    const field = this.fields.get(key);
    if (!field) return;
    field.known.add(value);
    const limit = Math.max(
      2,
      Math.min(64, Math.floor(524288 / Math.max(1, value.length))),
    );
    while (field.known.size > limit)
      field.known.delete(field.known.values().next().value!);
  }
  private replace(text: Y.Text, before: string, after: string) {
    if (before === after) return;
    const changes = diffChars(before, after, { timeout: 50 });
    if (!changes) throw new Error("merge-conflict");
    let offset = 0;
    for (const change of changes) {
      if (change.removed) text.delete(offset, change.value.length);
      else if (change.added) {
        text.insert(offset, change.value);
        offset += change.value.length;
      } else offset += change.value.length;
    }
  }
  edit(key: string, before: string, value: string) {
    const field = this.fields.get(key);
    if (!field) return;
    if (!this.has(key)) {
      field.pending = value;
      return;
    }
    const text = this.doc.getText(key);
    this.undoManager.addToScope(text);
    // Canvas receives remote changes synchronously, so its input and shared text
    // have the same offsets before the browser's next input event.
    this.doc.transact(() => this.replace(text, before, value), "local");
    this.remember(key, text.toString());
  }
  cursor(selection: LiveSelection) {
    this.selection = selection;
    const text =
      selection.field && this.has(selection.field)
        ? this.doc.getText(selection.field)
        : undefined;
    return {
      ...selection,
      anchor: text
        ? Y.relativePositionToJSON(
            Y.createRelativePositionFromTypeIndex(
              text,
              Math.min(selection.start ?? 0, text.length),
            ),
          )
        : null,
      head: text
        ? Y.relativePositionToJSON(
            Y.createRelativePositionFromTypeIndex(
              text,
              Math.min(selection.end ?? 0, text.length),
            ),
          )
        : null,
    };
  }
  participants(people: Collaborator[]): Collaborator[] {
    return people.map((person) => {
      const resolve = (value: unknown, fallback?: number) => {
        if (!value || typeof value !== "object") return fallback;
        try {
          return (
            Y.createAbsolutePositionFromRelativePosition(
              Y.createRelativePositionFromJSON(value),
              this.doc,
            )?.index ?? fallback
          );
        } catch {
          return fallback;
        }
      };
      return {
        ...person,
        start: resolve(person.anchor, person.start),
        end: resolve(person.head, person.end),
      };
    });
  }
  receive(data: string) {
    const cursor = this.cursor(this.selection);
    const previous = new Map(
      [...this.fields]
        .filter(([key]) => this.has(key))
        .map(([key]) => [key, this.doc.getText(key).toString()]),
    );
    Y.applyUpdate(this.doc, decodeUpdate(data), "remote");
    for (const [key, field] of this.fields) {
      if (!this.has(key)) continue;
      const text = this.doc.getText(key);
      this.undoManager.addToScope(text);
      if (field.pending !== undefined) {
        const pending = field.pending;
        field.pending = undefined;
        // First initialization uses the native field as the common baseline.
        // Apply a queued input after synchronization without replacing peers' text.
        const current = text.toString();
        if (current !== pending && current === field.baseline)
          this.doc.transact(
            () => this.replace(text, current, pending),
            "local",
          );
        else if (current !== pending && pending !== field.baseline) {
          const changes = diffChars(field.baseline, pending, { timeout: 50 });
          if (!changes) throw new Error("merge-conflict");
          let source = 0;
          const mapping = diffChars(field.baseline, current, { timeout: 50 });
          if (!mapping) throw new Error("merge-conflict");
          const at = (index: number) => {
            let from = 0,
              to = 0;
            for (const part of mapping) {
              if (part.added) to += part.value.length;
              else if (index <= from + part.value.length)
                return to + (part.removed ? 0 : index - from);
              else {
                from += part.value.length;
                if (!part.removed) to += part.value.length;
              }
            }
            return to;
          };
          const edits: Array<{ at: number; remove: number; insert: string }> =
            [];
          for (const part of changes) {
            if (part.added)
              edits.push({ at: at(source), remove: 0, insert: part.value });
            else if (part.removed) {
              edits.push({
                at: at(source),
                remove: at(source + part.value.length) - at(source),
                insert: "",
              });
              source += part.value.length;
            } else source += part.value.length;
          }
          this.doc.transact(() => {
            for (const edit of edits.reverse()) {
              if (edit.remove) text.delete(edit.at, edit.remove);
              if (edit.insert) text.insert(edit.at, edit.insert);
            }
          }, "local");
        }
      }
      const value = text.toString();
      this.remember(key, value);
      if (value === (previous.get(key) ?? field.baseline)) continue;
      let selection: LiveSelection | undefined;
      if (cursor.field === key && cursor.anchor && cursor.head) {
        const start = Y.createAbsolutePositionFromRelativePosition(
          Y.createRelativePositionFromJSON(cursor.anchor),
          this.doc,
        )?.index;
        const end = Y.createAbsolutePositionFromRelativePosition(
          Y.createRelativePositionFromJSON(cursor.head),
          this.doc,
        )?.index;
        selection = { field: key, start, end, direction: cursor.direction };
      }
      if (selection) this.selection = selection;
      for (const listener of this.listeners)
        listener({ key, value, selection });
    }
  }
  /** Project synchronized field values before merging durable XML revisions.
   * This avoids merging the same live insertion twice during concurrent saves. */
  project(xml: string, fileName: string): string {
    let model = new GaebDocument(xml, fileName);
    if (model.signed) return xml;
    for (const [key, field] of this.fields) {
      if (field.protectNative) continue;
      if (!this.has(key)) continue;
      const value = this.doc.getText(key).toString();
      if (value === field.baseline) continue;
      const entry = model.entries.find((entry) =>
        key.startsWith(`${entry.key}:`),
      );
      try {
        let source = model.source;
        if (entry) {
          const name = key.slice(entry.key.length + 1);
          const measure = measurementField(key, entry.key);
          if (name.startsWith("heading:"))
            source = model.setTakeoffHeading(entry, name.slice(8), value);
          else if (
            measure &&
            model.takeoff(entry).rows.some((row) => row.value.id === measure.id)
          )
            source = model.setMeasurementField(
              entry,
              measure.id,
              measure.name,
              value,
            );
          else if (name.startsWith("text:")) {
            const index = Number(name.slice(5));
            if (model.richGroups(entry)[index]?.text !== value)
              source = model.setRichGroupText(entry, index, value);
          } else if (["Qty", "QU", "UP"].includes(name))
            source = model.setValue(entry, name as "Qty" | "QU" | "UP", value);
        } else if (key === "document:title")
          source = model.setDocumentTitle(value);
        else if (key === "project:title") source = model.setProjectName(value);
        else if (key === "takeoff:title") source = model.setTakeoffTitle(value);
        else if (key.startsWith("meta:"))
          source = model.setMetadata(Number(key.slice(5)), value);
        if (source !== model.source) model = new GaebDocument(source, fileName);
      } catch {
        /* Invalid numeric drafts remain editable, but never enter storage. */
      }
    }
    return model.source;
  }
  acknowledge(xml: string, fileName: string) {
    const model = new GaebDocument(xml, fileName);
    this.native = model;
    for (const [key, field] of this.fields) {
      const value = this.nativeValue(model, key);
      if (value === undefined) continue;
      if (this.has(key)) {
        const text = this.doc.getText(key),
          previous = text.toString();
        if (
          previous !== field.baseline &&
          value !== field.baseline &&
          !field.known.has(value)
        ) {
          // External file replacements may not be represented in this live room.
          // Let the native three-way merge detect those conflicts instead of
          // allowing a text overlay to overwrite an unseen durable edit.
          field.protectNative = true;
          continue;
        }
        field.protectNative = false;
        if (previous === field.baseline && previous !== value) {
          this.doc.transact(
            () => this.replace(text, previous, value!),
            "snapshot",
          );
          for (const listener of this.listeners) listener({ key, value });
        }
      }
      field.baseline = value;
      this.remember(key, value);
    }
  }
  canUndo(direction: "undo" | "redo") {
    return (
      this.online &&
      this.writable &&
      (direction === "undo"
        ? this.undoManager.undoStack.length > 0
        : this.undoManager.redoStack.length > 0)
    );
  }
  undo(direction: "undo" | "redo") {
    if (!this.online || !this.writable) return false;
    const previous = new Map(
      [...this.fields].map(([key]) => [key, this.value(key)]),
    );
    if (direction === "undo") this.undoManager.undo();
    else this.undoManager.redo();
    for (const [key, value] of previous) {
      const current = this.value(key);
      if (current !== undefined && current !== value)
        for (const listener of this.listeners)
          listener({ key, value: current });
    }
    return true;
  }
  destroy() {
    this.listeners.clear();
    this.undoManager.destroy();
    this.doc.destroy();
  }
}
