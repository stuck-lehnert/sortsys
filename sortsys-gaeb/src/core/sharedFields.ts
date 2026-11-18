import type { Collaborator, EditorField } from "../canvas/types";
import { GAEB_CONTENT_FACETS, type GaebContentFacet } from "./contentFacets";
import { GaebDocument } from "./document";
import { nativeFieldFacet } from "./fieldBindings";
import {
  InvalidSharedUpdate,
  SharedFieldPartition,
  type LiveSelection,
  type SharedFieldChange,
  type SharedFieldReception,
  type SharedFieldConnectionOptions,
} from "./sharedFieldPartition";

export {
  decodeUpdate,
  encodeUpdate,
  initializeSharedField,
  mergeSharedUpdates,
  InvalidSharedUpdate,
  type LiveSelection,
  type SharedFieldChange,
  type SharedFieldReception,
} from "./sharedFieldPartition";

type Connection = {
  send: (message: Record<string, unknown>) => void;
  writable: boolean;
  epoch?: string;
} & SharedFieldConnectionOptions;

/** Legacy XML sessions use one document until migration. Protected sessions
 * enable independent Yjs identities, text and undo histories per content facet.
 * A packet from one facet can never project into another facet's native fields. */
export class SharedFields {
  private readonly fields = new Map<string, EditorField>();
  private readonly partitions = new Map<
    GaebContentFacet,
    SharedFieldPartition
  >();
  private readonly listeners = new Set<(change: SharedFieldChange) => void>();
  private readonly fallback: SharedFieldPartition;
  private faceted = false;
  private frozen = false;
  private closed = false;
  private connection: Connection | undefined;
  private readonly facetConnections = new Map<GaebContentFacet, Connection>();
  private native: GaebDocument | undefined;
  private lastEdited: SharedFieldPartition | undefined;
  private notifications: SharedFieldChange[] | undefined;

  constructor(private readonly documentKind?: string) {
    this.fallback = new SharedFieldPartition();
    this.observe(this.fallback);
  }

  private observe(partition: SharedFieldPartition) {
    partition.subscribe((change) => {
      if (this.notifications) {
        this.notifications.push(change);
      } else {
        this.notify(change);
      }
    });
  }

  private notify(change: SharedFieldChange) {
    for (const listener of this.listeners) {
      listener(change);
    }
  }

  private active() {
    if (this.closed) {
      throw new InvalidSharedUpdate();
    }
  }

  /** Enable before a protected transport starts; never reinterpret an already
   * connected or received unpartitioned Yjs state as a scoped state. */
  enableFacets() {
    this.active();
    if (this.faceted || this.frozen) {
      return;
    }
    if (this.fallback.hasLiveState()) {
      throw new InvalidSharedUpdate();
    }
    const pending = new Map<string, string>();
    for (const key of this.fields.keys()) {
      const value = this.fallback.draftValue(key);
      if (value !== undefined) {
        pending.set(key, value);
      }
    }
    this.faceted = true;
    this.fallback.destroy();
    this.lastEdited = undefined;
    this.register(new Map(this.fields));
    for (const [key, value] of pending) {
      const field = this.fields.get(key)!;
      this.partition(this.facetOf(key)!).edit(key, field.value, value);
    }
  }

  facetOf(key: string): GaebContentFacet | undefined {
    const field = this.fields.get(key);
    if (!field) {
      return this.native
        ? nativeFieldFacet(this.native, key, this.documentKind)
        : undefined;
    }
    return field.facet ?? "scope";
  }

  private partition(facet: GaebContentFacet): SharedFieldPartition {
    this.active();
    if (!GAEB_CONTENT_FACETS.includes(facet)) {
      throw new InvalidSharedUpdate();
    }
    let partition = this.partitions.get(facet);
    if (!partition) {
      partition = new SharedFieldPartition((key) => {
        const owner = this.facetOf(key);
        return owner === undefined || owner === facet;
      });
      this.partitions.set(facet, partition);
      this.observe(partition);
      if (this.native) {
        partition.acknowledgeModel(this.native);
      }
      if (this.connection || this.facetConnections.has(facet)) {
        this.connectPartition(facet, partition);
      }
    }
    return partition;
  }

  private stores(): SharedFieldPartition[] {
    if (!this.faceted) {
      return [this.fallback];
    }
    return [...this.partitions.values()];
  }

  private forField(key: string): SharedFieldPartition {
    this.active();
    if (!this.faceted) {
      return this.fallback;
    }
    return this.partition(this.facetOf(key) ?? "scope");
  }

  private connectPartition(
    facet: GaebContentFacet,
    partition: SharedFieldPartition,
  ) {
    const connection = this.facetConnections.get(facet) ?? this.connection;
    if (!connection) {
      throw new InvalidSharedUpdate();
    }
    const epoch =
      connection.epoch === undefined
        ? undefined
        : `${connection.epoch}:${facet}`;
    partition.connect(
      (message) => connection.send({ ...message, facet }),
      connection.writable,
      epoch,
      { initializeOnEdit: connection.initializeOnEdit },
    );
  }

  connect(
    send: Connection["send"],
    writable: boolean,
    epoch?: string,
    options: SharedFieldConnectionOptions = {},
  ) {
    this.active();
    if (this.frozen) {
      return;
    }
    this.connection = { send, writable, epoch, ...options };
    this.facetConnections.clear();
    if (!this.faceted) {
      this.fallback.connect(send, writable, epoch, options);
      return;
    }
    for (const [facet, partition] of this.partitions) {
      this.connectPartition(facet, partition);
    }
  }

  connectFacet(
    facet: GaebContentFacet,
    send: Connection["send"],
    writable: boolean,
    epoch: string,
    options: SharedFieldConnectionOptions = {},
  ) {
    this.active();
    if (!this.faceted || this.connection) {
      throw new InvalidSharedUpdate();
    }
    if (this.frozen) {
      return;
    }
    const partition = this.partition(facet);
    this.facetConnections.set(facet, { send, writable, epoch, ...options });
    this.connectPartition(facet, partition);
  }

  disconnectFacet(facet: GaebContentFacet) {
    this.facetConnections.delete(facet);
    this.partitions.get(facet)?.disconnect();
  }

  disconnect() {
    this.connection = undefined;
    this.facetConnections.clear();
    for (const partition of this.stores()) {
      partition.disconnect();
    }
  }

  register(fields: Map<string, EditorField>) {
    this.active();
    const groups = new Map<GaebContentFacet, Map<string, EditorField>>();
    for (const [key, field] of fields) {
      const previous = this.fields.get(key);
      const facet = field.facet ?? "scope";
      if (previous && (previous.facet ?? "scope") !== facet) {
        throw new InvalidSharedUpdate();
      }
      this.fields.set(key, field);
      const group = groups.get(facet) ?? new Map();
      group.set(key, field);
      groups.set(facet, group);
    }
    if (!this.faceted) {
      this.fallback.register(fields);
      return;
    }
    for (const [facet, group] of groups) {
      this.partition(facet).register(group);
    }
  }

  subscribe(listener: (change: SharedFieldChange) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  commonBaseline(key: string, value: string, facet?: GaebContentFacet) {
    const partition =
      this.faceted && facet ? this.partition(facet) : this.forField(key);
    partition.commonBaseline(key, value);
  }

  value(key: string) {
    return this.forField(key).value(key);
  }

  edit(key: string, before: string, value: string) {
    const partition = this.forField(key);
    if (partition !== this.lastEdited) {
      this.lastEdited?.stopCapturing();
      partition.stopCapturing();
      this.lastEdited = partition;
    }
    partition.edit(key, before, value);
  }

  cursor(selection: LiveSelection) {
    const partition = selection.field
      ? this.forField(selection.field)
      : this.forField("");
    return partition.cursor(selection);
  }

  participants(people: Collaborator[]): Collaborator[] {
    return people.flatMap((person) => {
      const owner = person.field ? this.facetOf(person.field) : undefined;
      if (
        this.faceted &&
        person.field &&
        (owner === undefined || owner !== person.facet)
      ) {
        return [
          {
            ...person,
            field: null,
            start: undefined,
            end: undefined,
            anchor: undefined,
            head: undefined,
          },
        ];
      }
      const partition = person.field
        ? this.forField(person.field)
        : this.forField("");
      return partition.participants([person]);
    });
  }

  beginReceive(): SharedFieldReception {
    if (!this.faceted) {
      return this.fallback.beginReceive();
    }
    const batches = new Map<GaebContentFacet, SharedFieldReception>();
    let finished = false;
    let prepared = false;
    const active = () => {
      this.active();
      if (finished || this.frozen) {
        throw new InvalidSharedUpdate();
      }
    };
    const batch = (facet: GaebContentFacet) => {
      active();
      if (prepared) {
        throw new InvalidSharedUpdate();
      }
      let reception = batches.get(facet);
      if (!reception) {
        reception = this.partition(facet).beginReceive();
        batches.set(facet, reception);
      }
      return reception;
    };
    const destroy = () => {
      if (!finished) {
        finished = true;
        for (const reception of batches.values()) {
          reception.destroy();
        }
      }
    };
    const prepare = () => {
      active();
      if (prepared) {
        throw new InvalidSharedUpdate();
      }
      const apply = [...batches.values()].map((reception) =>
        reception.prepare(),
      );
      prepared = true;
      return () => {
        active();
        this.notifications = [];
        try {
          for (const commit of apply) {
            commit();
          }
          const notifications = this.notifications;
          this.notifications = undefined;
          for (const change of notifications) {
            this.notify(change);
          }
        } finally {
          this.notifications = undefined;
          destroy();
        }
      };
    };
    return {
      update: (data, facet = "scope") => batch(facet).update(data),
      initialize: (key, value, data, facet = "scope") =>
        batch(facet).initialize(key, value, data),
      prepare,
      commit: () => prepare()(),
      destroy,
    };
  }

  receiveInitialization(
    key: string,
    value: string,
    data: string,
    facet: GaebContentFacet = "scope",
  ) {
    if (this.frozen) {
      return false;
    }
    const reception = this.beginReceive();
    try {
      const accepted = reception.initialize(key, value, data, facet);
      reception.commit();
      return accepted;
    } finally {
      reception.destroy();
    }
  }

  receive(data: string, facet: GaebContentFacet = "scope") {
    if (this.frozen) {
      return;
    }
    const reception = this.beginReceive();
    try {
      reception.update(data, facet);
      reception.commit();
    } finally {
      reception.destroy();
    }
  }

  project(xml: string, fileName: string) {
    this.active();
    if (this.frozen) {
      return xml;
    }
    let model = new GaebDocument(xml, fileName);
    if (model.signed) {
      return xml;
    }
    for (const partition of this.stores()) {
      model = partition.projectModel(model);
    }
    return model.source;
  }

  acknowledge(xml: string, fileName: string) {
    this.active();
    this.native = new GaebDocument(xml, fileName);
    for (const partition of this.stores()) {
      partition.acknowledgeModel(this.native);
    }
  }

  captureReplay(facet: GaebContentFacet) {
    this.active();
    return this.partitions.get(facet)?.captureReplay();
  }

  matchesReplay(
    facet: GaebContentFacet,
    data: string,
    model: GaebDocument,
  ) {
    this.active();
    return this.partition(facet).matchesReplay(data, model);
  }

  restoreReplay(facet: GaebContentFacet, data: string) {
    return this.restoreReplays({ [facet]: data });
  }

  /** A single attachment cursor covers all of its text partitions. Check
   * every partition before changing any of them or showing new text. */
  restoreReplays(data: Partial<Record<GaebContentFacet, string>>) {
    this.active();
    const commits: (() => void)[] = [];
    for (const facet of GAEB_CONTENT_FACETS) {
      const value = data[facet];
      if (value === undefined) continue;
      const commit = this.partition(facet).prepareReplay(value);
      if (!commit) return false;
      commits.push(commit);
    }
    if (commits.length === 0) return false;
    this.notifications = [];
    try {
      for (const commit of commits) commit();
      const notifications = this.notifications;
      this.notifications = undefined;
      for (const change of notifications) this.notify(change);
    } finally {
      this.notifications = undefined;
    }
    return true;
  }

  freeze(xml: string, fileName: string) {
    this.active();
    this.frozen = true;
    this.native = new GaebDocument(xml, fileName);
    this.connection = undefined;
    this.facetConnections.clear();
    for (const partition of this.stores()) {
      partition.freezeModel(this.native);
    }
  }

  private undoPartition(direction: "undo" | "redo") {
    let selected: SharedFieldPartition | undefined;
    for (const partition of this.stores()) {
      if (
        partition.canUndo(direction) &&
        (!selected ||
          partition.historyStamp(direction) > selected.historyStamp(direction))
      ) {
        selected = partition;
      }
    }
    return selected;
  }

  canUndo(direction: "undo" | "redo") {
    return this.undoPartition(direction) !== undefined;
  }

  undo(direction: "undo" | "redo") {
    return this.undoPartition(direction)?.undo(direction) ?? false;
  }

  destroy() {
    this.closed = true;
    this.connection = undefined;
    this.facetConnections.clear();
    this.listeners.clear();
    this.fields.clear();
    for (const partition of this.stores()) {
      partition.destroy();
    }
    this.partitions.clear();
    this.native = undefined;
  }
}
