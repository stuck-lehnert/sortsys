import { measurementField } from "./takeoffLabels";
import * as Y from "yjs";
import { diffChars } from "diff";
import { GaebDocument } from "./document";
import type { Collaborator, EditorField } from "../canvas/types";
import { entryForField, metadataField } from "./fieldBindings";
import {
  checkedSharedUpdate,
  checkFieldInitialization,
  InvalidSharedUpdate,
  pendingTextEdits,
  type TextEdit,
} from "./sharedFieldUpdates";

export { InvalidSharedUpdate } from "./sharedFieldUpdates";

export type SharedFieldConnectionOptions = { initializeOnEdit?: boolean };

export type SharedFieldReception = {
  update(
    data: string,
    facet?: import("./contentFacets").GaebContentFacet,
  ): void;
  initialize(
    key: string,
    value: string,
    data: string,
    facet?: import("./contentFacets").GaebContentFacet,
  ): boolean;
  prepare(): () => void;
  commit(): void;
  destroy(): void;
};

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
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
};
export const decodeUpdate = (value: string) =>
  Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

function readSharedUpdate(value: string): Uint8Array {
  try {
    if (value.length > 32 * 1024 * 1024) {
      throw new InvalidSharedUpdate();
    }
    return decodeUpdate(value);
  } catch {
    throw new InvalidSharedUpdate();
  }
}

/** Receivers choose the first valid initializer in the ordered encrypted log.
 * Every peer applies that same Yjs identity instead of inserting text twice. */
export function initializeSharedField(key: string, value: string): string {
  const document = new Y.Doc();
  try {
    document.getMap("__fields").set(key, true);
    document.getText(key).insert(0, value);
    return encodeUpdate(Y.encodeStateAsUpdate(document));
  } finally {
    document.destroy();
  }
}

export function mergeSharedUpdates(updates: readonly string[]): string {
  return encodeUpdate(Y.mergeUpdates(updates.map(decodeUpdate)));
}

/** Only editable field text enters the CRDT. Native XML, formatting and unknown
 * extensions remain in the versioned file and its conservative structure merge. */
let historyOrder = 0;

export class SharedFieldPartition {
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
      pendingBaseline?: string;
      known: Set<string>;
      protectNative?: boolean;
      editable: boolean;
    }
  >();
  private native: GaebDocument | undefined;
  private listeners = new Set<(change: SharedFieldChange) => void>();
  private epoch: string | undefined;
  private online = false;
  private writable = false;
  private initializeOnEdit = false;
  private frozen = false;
  private selection: LiveSelection = { field: null };
  private commonBaselines = new Map<string, string>();
  private initializing = new Set<string>();
  private send: ((message: Record<string, unknown>) => void) | undefined;
  constructor(private readonly allowsField?: (key: string) => boolean) {
    this.observeUpdates();
    this.observeHistory();
  }
  private observeHistory() {
    const remember = ({
      stackItem,
    }: {
      stackItem: { meta: Map<unknown, unknown> };
    }) => {
      historyOrder += 1;
      stackItem.meta.set("sortsys-order", historyOrder);
    };
    this.undoManager.on("stack-item-added", remember);
    this.undoManager.on("stack-item-updated", remember);
  }
  historyStamp(direction: "undo" | "redo"): number {
    const stack =
      direction === "undo"
        ? this.undoManager.undoStack
        : this.undoManager.redoStack;
    return Number(stack.at(-1)?.meta.get("sortsys-order") ?? 0);
  }
  stopCapturing() {
    this.undoManager.stopCapturing();
  }
  draftValue(key: string) {
    return this.fields.get(key)?.pending ?? this.value(key);
  }
  hasLiveState() {
    return this.online || this.doc.store.clients.size > 0;
  }
  private observeUpdates() {
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== "remote" && this.online && this.writable) {
        this.send?.({ type: "update", data: encodeUpdate(update) });
      }
    });
  }
  connect(
    send: (message: Record<string, unknown>) => void,
    writable: boolean,
    epoch?: string,
    options: SharedFieldConnectionOptions = {},
  ) {
    if (this.frozen) {
      return;
    }
    if (
      epoch !== undefined &&
      this.epoch !== undefined &&
      epoch !== this.epoch
    ) {
      this.newSession();
    }
    if (epoch !== undefined) {
      this.epoch = epoch;
    }
    this.send = send;
    this.online = true;
    this.writable = writable;
    this.initializeOnEdit = options.initializeOnEdit === true;
    if (this.doc.store.clients.size && writable) {
      send({
        type: "update",
        data: encodeUpdate(Y.encodeStateAsUpdate(this.doc)),
      });
    }
    this.initialize();
  }
  private newSession() {
    this.online = false;
    this.initializing.clear();
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
      field.pendingBaseline =
        field.pending === undefined ? undefined : field.baseline;
      field.known = new Set([
        field.baseline,
        ...(field.pending === undefined ? [] : [field.pending]),
      ]);
    }
    this.commonBaselines.clear();
    this.undoManager.destroy();
    this.doc.destroy();
    this.doc = new Y.Doc();
    this.undoManager = new Y.UndoManager(this.doc, {
      trackedOrigins: new Set(["local"]),
      captureTimeout: 500,
    });
    this.observeUpdates();
    this.observeHistory();
  }
  disconnect() {
    this.online = false;
    this.initializing.clear();
  }
  /** A final signed file is authoritative; historical room text cannot overlay
   * it. The host retains a conflicting local draft before freezing this state. */
  freeze(xml: string, fileName: string) {
    this.freezeModel(new GaebDocument(xml, fileName));
  }
  freezeModel(model: GaebDocument) {
    this.online = false;
    this.writable = false;
    this.frozen = true;
    this.send = undefined;
    this.undoManager.destroy();
    this.doc.destroy();
    this.doc = new Y.Doc();
    this.undoManager = new Y.UndoManager(this.doc);
    this.commonBaselines.clear();
    this.native = model;
    for (const [key, field] of this.fields) {
      const value = this.nativeValue(this.native, key) ?? field.baseline;
      field.baseline = value;
      field.pending = undefined;
      field.pendingBaseline = undefined;
      field.protectNative = false;
      field.known = new Set([value]);
    }
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
      const previous = this.fields.get(field.key);
      if (previous) {
        if (previous.editable && !field.editable) {
          previous.pending = undefined;
          previous.pendingBaseline = undefined;
          this.undoManager.clear();
        }
        previous.editable = field.editable;
        continue;
      }
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
      ) {
        continue;
      }
      const baseline =
        this.commonBaselines.get(field.key) ??
        this.nativeValue(this.native, field.key) ??
        field.value;
      let pending: string | undefined;
      if (field.value !== baseline && field.value !== this.value(field.key)) {
        pending = field.value;
      }
      this.fields.set(field.key, {
        editable: field.editable,
        baseline,
        pending,
        pendingBaseline: pending === undefined ? undefined : baseline,
        known: new Set([baseline, field.value]),
      });
      added = true;
    }
    if (added) {
      this.initialize();
    }
  }
  commonBaseline(key: string, value: string) {
    if (this.commonBaselines.has(key)) {
      return;
    }
    this.commonBaselines.set(key, value);
    const field = this.fields.get(key);
    if (field) {
      field.baseline = value;
      field.known.add(value);
    }
  }
  private initialize() {
    const send = this.send;
    if (!this.online || !this.writable || !send) {
      return;
    }
    const fields = [...this.fields]
      .filter(
        ([key, field]) =>
          field.editable &&
          (!this.initializeOnEdit || field.pending !== undefined) &&
          !this.has(key) &&
          !this.initializing.has(key),
      )
      .map(([key, field]) => ({ key, value: field.baseline }));
    // Keep individual websocket messages bounded even for large specifications.
    for (const field of fields) {
      // Registering more canvas fields must not repeatedly enqueue candidates
      // whose first messages are still waiting for acknowledgement.
      this.initializing.add(field.key);
      try {
        send({ type: "initialize", ...field });
      } catch (error) {
        this.initializing.delete(field.key);
        throw error;
      }
    }
  }
  private nativeValue(
    model: GaebDocument | undefined,
    key: string,
  ): string | undefined {
    if (!model) {
      return undefined;
    }
    if (key === "takeoff:title") {
      return model.takeoffTitle;
    }
    if (key === "document:title") {
      return model.documentTitle;
    }
    if (key === "project:title") {
      return model.projectName();
    }
    const entry = entryForField(model, key);
    if (entry) {
      if (key.startsWith(`${entry.key}:heading:`)) {
        return model
          .takeoff(entry)
          .headings.find(
            (row) => row.value.id === key.slice(entry.key.length + 9),
          )?.value.title;
      }
      const measure = measurementField(key, entry.key);
      if (measure) {
        return model
          .takeoff(entry)
          .rows.find((row) => row.value.id === measure.id)?.value[measure.name];
      }
    }
    if (entry && key.slice(entry.key.length + 1).startsWith("text:")) {
      return model.richGroups(entry)[Number(key.slice(entry.key.length + 6))]
        ?.text;
    }
    if (key.startsWith("meta:")) {
      return metadataField(model, key)?.element.textContent ?? undefined;
    }
    return undefined;
  }
  private remember(key: string, value: string) {
    const field = this.fields.get(key);
    if (!field) {
      return;
    }
    field.known.add(value);
    const limit = Math.max(
      2,
      Math.min(64, Math.floor(524288 / Math.max(1, value.length))),
    );
    while (field.known.size > limit) {
      field.known.delete(field.known.values().next().value!);
    }
  }
  private replace(text: Y.Text, before: string, after: string) {
    if (before === after) {
      return;
    }
    const changes = diffChars(before, after, { timeout: 50 });
    if (!changes) {
      throw new Error("merge-conflict");
    }
    let offset = 0;
    for (const change of changes) {
      if (change.removed) {
        text.delete(offset, change.value.length);
      } else if (change.added) {
        text.insert(offset, change.value);
        offset += change.value.length;
      } else {
        offset += change.value.length;
      }
    }
  }
  edit(key: string, before: string, value: string) {
    if (before === value) return;
    if (this.frozen || (this.online && !this.writable)) {
      return;
    }
    const field = this.fields.get(key);
    if (!field || !field.editable) {
      return;
    }
    if (!this.has(key)) {
      field.pendingBaseline ??= before;
      field.pending = value;
      this.initialize();
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
        if (!value || typeof value !== "object") {
          return fallback;
        }
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
  private checkedUpdate(source: Y.Doc, update: Uint8Array): Y.Doc {
    const next = checkedSharedUpdate(source, update);
    if (!this.allowsField) {
      return next;
    }
    try {
      const previousFields = source.getMap("__fields");
      const nextFields = next.getMap("__fields");
      const keys = new Set([...previousFields.keys(), ...nextFields.keys()]);
      for (const key of keys) {
        if (this.allowsField(key)) {
          continue;
        }
        const previousValue = source.share.has(key)
          ? source.getText(key).toString()
          : undefined;
        const nextValue = next.share.has(key)
          ? next.getText(key).toString()
          : undefined;
        if (
          previousFields.get(key) !== nextFields.get(key) ||
          previousValue !== nextValue
        ) {
          throw new InvalidSharedUpdate();
        }
      }
      return next;
    } catch {
      next.destroy();
      throw new InvalidSharedUpdate();
    }
  }
  /** Stage a log page without changing text, pending input or common baselines.
   * The caller may discard this batch after a failed network read. */
  beginReceive(): SharedFieldReception {
    let candidate = new Y.Doc();
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(this.doc));
    const baselines = new Map<string, string>();
    const updates: Uint8Array[] = [];
    let finished = false;
    let prepared = false;
    const active = () => {
      if (finished || this.frozen) {
        throw new InvalidSharedUpdate();
      }
    };
    const stage = (update: Uint8Array) => {
      if (prepared) {
        throw new InvalidSharedUpdate();
      }
      const next = this.checkedUpdate(candidate, update);
      candidate.destroy();
      candidate = next;
      updates.push(update);
    };
    const destroy = () => {
      if (!finished) {
        finished = true;
        candidate.destroy();
      }
    };
    const prepare = () => {
      active();
      if (prepared) {
        throw new InvalidSharedUpdate();
      }
      const apply =
        updates.length > 0
          ? this.prepareReceived(Y.mergeUpdates(updates), baselines)
          : () => {};
      prepared = true;
      return () => {
        active();
        try {
          apply();
        } finally {
          destroy();
        }
      };
    };
    return {
      update(data) {
        active();
        stage(readSharedUpdate(data));
      },
      initialize: (key, value, data) => {
        active();
        if (prepared || this.allowsField?.(key) === false) {
          throw new InvalidSharedUpdate();
        }
        const alreadyInitialized =
          this.commonBaselines.has(key) ||
          baselines.has(key) ||
          candidate.getMap("__fields").has(key);
        if (alreadyInitialized) {
          return false;
        }
        const update = readSharedUpdate(data);
        checkFieldInitialization(key, value, update);
        stage(update);
        baselines.set(key, value);
        return true;
      },
      prepare,
      commit: () => prepare()(),
      destroy,
    };
  }
  receiveInitialization(key: string, value: string, data: string): boolean {
    if (this.frozen) {
      return false;
    }
    const reception = this.beginReceive();
    try {
      const accepted = reception.initialize(key, value, data);
      reception.commit();
      return accepted;
    } finally {
      reception.destroy();
    }
  }
  receive(data: string) {
    if (this.frozen) {
      return;
    }
    const reception = this.beginReceive();
    try {
      reception.update(data);
      reception.commit();
    } finally {
      reception.destroy();
    }
  }
  private prepareReceived(
    update: Uint8Array,
    baselines: ReadonlyMap<string, string>,
  ) {
    // Local typing can continue while a network page is being read. Rebase the
    // staged updates and plan every pending merge against the current text.
    const checked = this.checkedUpdate(this.doc, update);
    const plans: Array<{ key: string; edits: TextEdit[] }> = [];
    try {
      for (const [key, field] of this.fields) {
        if (
          field.pending === undefined ||
          !checked.getMap("__fields").has(key)
        ) {
          continue;
        }
        plans.push({
          key,
          edits: pendingTextEdits(
            // A live room may have been initialized long before the current
            // native snapshot. Early typing replaces what this client saw,
            // rather than text from that historical initializer.
            field.pendingBaseline ?? field.baseline,
            field.pending,
            checked.getText(key).toString(),
          ),
        });
      }
    } finally {
      checked.destroy();
    }

    return () => {
      const cursor = this.cursor(this.selection);
      const previous = new Map(
        [...this.fields].map(([key, field]) => [
          key,
          this.value(key) ?? field.pending ?? field.baseline,
        ]),
      );
      Y.applyUpdate(this.doc, update, "remote");
      for (const [key, value] of baselines) {
        this.commonBaseline(key, value);
      }
      for (const plan of plans) {
        const field = this.fields.get(plan.key)!;
        const text = this.doc.getText(plan.key);
        this.undoManager.addToScope(text);
        field.pending = undefined;
        field.pendingBaseline = undefined;
        this.doc.transact(() => {
          for (const edit of plan.edits) {
            if (edit.remove > 0) {
              text.delete(edit.at, edit.remove);
            }
            if (edit.insert) {
              text.insert(edit.at, edit.insert);
            }
          }
        }, "local");
      }
      for (const [key, field] of this.fields) {
        if (!this.has(key)) {
          continue;
        }
        const text = this.doc.getText(key);
        this.undoManager.addToScope(text);
        const value = text.toString();
        this.remember(key, value);
        if (value === (previous.get(key) ?? field.baseline)) {
          continue;
        }
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
        if (selection) {
          this.selection = selection;
        }
        for (const listener of this.listeners) {
          listener({ key, value, selection });
        }
      }
    };
  }
  /** Project synchronized field values before merging durable XML revisions.
   * This avoids merging the same live insertion twice during concurrent saves. */
  project(xml: string, fileName: string): string {
    if (this.frozen) {
      return xml;
    }
    const model = new GaebDocument(xml, fileName);
    if (model.signed) {
      return xml;
    }
    return this.projectModel(model).source;
  }
  projectModel(initial: GaebDocument): GaebDocument {
    let model = initial;
    if (this.frozen || model.signed) {
      return model;
    }
    for (const [key, field] of this.fields) {
      if (field.protectNative) {
        continue;
      }
      if (!this.has(key)) {
        continue;
      }
      const value = this.doc.getText(key).toString();
      if (value === field.baseline) {
        continue;
      }
      const entry = entryForField(model, key);
      try {
        let source = model.source;
        if (entry) {
          const name = key.slice(entry.key.length + 1);
          const measure = measurementField(key, entry.key);
          if (name.startsWith("heading:")) {
            source = model.setTakeoffHeading(entry, name.slice(8), value);
          } else if (
            measure &&
            model.takeoff(entry).rows.some((row) => row.value.id === measure.id)
          ) {
            source = model.setMeasurementField(
              entry,
              measure.id,
              measure.name,
              value,
            );
          } else if (name.startsWith("text:")) {
            const index = Number(name.slice(5));
            if (model.richGroups(entry)[index]?.text !== value) {
              source = model.setRichGroupText(entry, index, value);
            }
          } else if (["Qty", "QU", "UP"].includes(name)) {
            source = model.setValue(entry, name as "Qty" | "QU" | "UP", value);
          }
        } else if (key === "document:title") {
          source = model.setDocumentTitle(value);
        } else if (key === "project:title") {
          source = model.setProjectName(value);
        } else if (key === "takeoff:title") {
          source = model.setTakeoffTitle(value);
        } else if (key.startsWith("meta:")) {
          const target = metadataField(model, key);
          if (target) {
            source = model.setMetadata(target.index, value);
          }
        }
        if (source !== model.source) {
          model = new GaebDocument(source, model.fileName);
        }
      } catch {
        /* Invalid numeric drafts remain editable, but never enter storage. */
      }
    }
    return model;
  }
  acknowledge(xml: string, fileName: string) {
    this.acknowledgeModel(new GaebDocument(xml, fileName));
  }
  acknowledgeModel(model: GaebDocument) {
    this.native = model;
    for (const [key, field] of this.fields) {
      const value = this.nativeValue(model, key);
      if (value === undefined) {
        continue;
      }
      if (this.has(key)) {
        const text = this.doc.getText(key);
        const previous = text.toString();
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
          for (const listener of this.listeners) {
            listener({ key, value });
          }
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
    if (!this.online || !this.writable) {
      return false;
    }
    const previous = new Map(
      [...this.fields].map(([key]) => [key, this.value(key)]),
    );
    if (direction === "undo") {
      this.undoManager.undo();
    } else {
      this.undoManager.redo();
    }
    for (const [key, value] of previous) {
      const current = this.value(key);
      if (current !== undefined && current !== value) {
        for (const listener of this.listeners) {
          listener({ key, value: current });
        }
      }
    }
    return true;
  }
  destroy() {
    this.online = false;
    this.writable = false;
    this.frozen = true;
    this.send = undefined;
    this.native = undefined;
    this.fields.clear();
    this.initializing.clear();
    this.commonBaselines.clear();
    this.selection = { field: null };
    this.listeners.clear();
    this.undoManager.clear();
    this.undoManager.destroy();
    this.doc.destroy();
  }
}
