import { InvalidProtectedData } from "@sortsys/zerotrust";
import { isWriteConflict, ProtectedWriteConflict, type PreparedWrites } from "../atomicWrites";
import { createBusinessDatabase, type BusinessDatabase, type DuckDriver } from "../database";
import type { Collection } from "../protectedObjects";
import { dataAreaKey, dataDocumentKey, dataKey, modelTables, openDataDocument, setDataPath, type DataDocument, type DataModel } from "./model";
import { DataRow, patchDataRecord, projectDataRows, UnloadedDataField } from "./rows";
import { tableDefinition } from "../schema";
import { projectRuntimeRows, type DataTables } from "./sql";
import type { DataCollection, DataStorage } from "./storage";

export type DataRequest<T = unknown> = { model: DataModel<T>; area: Collection; ids?: readonly string[] };
export type DataVersion = { domain: string; id: string; revision: string; signature: string };
type TransactionOptions = { retries?: number; verified?: (versions: readonly DataVersion[]) => void };
type DataAction = "read" | "create" | "update" | "delete";
export type PreparedData<T> = { value: T; groups: PreparedWrites[]; guards: PreparedWrites["head"][]; versions: readonly DataVersion[]; close(): void };
type Resource = { request: DataRequest; head: string; documents: DataDocument<unknown>[]; complete: boolean; known: ReadonlySet<string>; permissions: Readonly<Record<DataAction, boolean>> };
export class DataView {
  constructor(protected resources: ReadonlyMap<string, Resource>, protected tables: DataTables,
    protected readonly live: () => void, protected readonly database: () => Promise<BusinessDatabase>) {}
  can(request: DataRequest, action: DataAction): boolean {
    this.live(); const resource = this.resources.get(dataAreaKey(request.area));
    if (!resource || resource.request.model !== request.model) throw new InvalidProtectedData();
    return resource.permissions[action];
  }
  documents<T>(request: DataRequest<T>): { id: string; revision: string; signature: string | undefined; value: T }[] {
    this.live(); const resource = this.resources.get(dataAreaKey(request.area));
    if (!resource || resource.request.model !== request.model) throw new InvalidProtectedData();
    const selected = request.ids && new Set(request.ids);
    if (!resource.complete && (!selected || [...selected].some(id => !resource.known.has(id)))) throw new InvalidProtectedData();
    return resource.documents.filter(document => !selected || selected.has(document.object.envelope.object)).map(document => ({ id: document.object.envelope.object, revision: document.object.envelope.revision, signature: document.object.envelope.signature, value: structuredClone(document.value) as T }));
  }
  head(request: DataRequest): { domain: string; sequence: string } {
    this.live(); const resource = this.resources.get(dataAreaKey(request.area));
    if (!resource || resource.request.model !== request.model) throw new InvalidProtectedData();
    return { domain: request.area.domain, sequence: resource.head };
  }
  rows(table: string): DataRow[] { this.live(); return [...this.tables.get(table)?.values() ?? []].map(row => new DataRow(row, this.live)); }
  row(table: string, primary: Record<string, unknown>): DataRow {
    this.live(); const row = this.tables.get(table)?.get(dataKey(table, primary)); if (!row) throw new InvalidProtectedData(); return new DataRow(row, this.live);
  }
  async query<T>(fields: Readonly<Record<string, readonly string[]>>, sql: string, parameters?: unknown[]): Promise<T[]> {
    this.live();
    for (const [table, columns] of Object.entries(fields)) {
      const declared = [...this.resources.values()].some(resource => modelTables(resource.request.model, resource.request.area)?.includes(table) || resource.documents.some(document => document.sources.some(source => source.table === table)));
      if (!declared) throw new UnloadedDataField();
      for (const resource of this.resources.values()) if (!resource.complete) {
        const known = modelTables(resource.request.model, resource.request.area) ?? [...new Set(resource.documents.flatMap(document => document.sources.map(source => source.table)))];
        if (known.includes(table) || !known.length && resource.request.model.tables === undefined) throw new UnloadedDataField();
      }
      for (const row of this.rows(table)) row.pick(columns);
    }
    const result = await (await this.database()).query<T>(sql, parameters); this.live(); return result.rows;
  }
}
export class DataTransaction extends DataView {
  constructor(resources: ReadonlyMap<string, Resource>, tables: DataTables, live: () => void, database: () => Promise<BusinessDatabase>,
    private readonly permitted: (request: DataRequest, action: "read" | "create" | "update" | "delete") => boolean) {
    super(resources, tables, live, database);
  }
  require(request: DataRequest, action: "read" | "create" | "update" | "delete"): void {
    this.live(); if (!this.permitted(request, action)) throw new InvalidProtectedData();
  }
  expect(request: DataRequest, id: string, expected: { signature?: string; revision?: string }): void {
    const document = this.documents(request).find(document => document.id === id);
    if (!document || expected.signature !== undefined && expected.signature !== document.signature || expected.revision !== undefined && expected.revision !== document.revision) throw new ProtectedWriteConflict();
  }
  private readonly changes = new Map<string, DataDocument<unknown>>();
  snapshotChanges(): Map<string, DataDocument<unknown>> {
    this.live(); return new Map([...this.changes].map(([key, document]) => [key, openDataDocument(document.model, document.area, { ...document.object, value: document.value })]));
  }
  private readonly originalResources = this.resources;
  private readonly originalTables = this.tables;
  override async query<T>(fields: Readonly<Record<string, readonly string[]>>, sql: string, parameters?: unknown[]): Promise<T[]> {
    if (!this.changes.size) return super.query<T>(fields, sql, parameters);
    const database = await this.database();
    try {
      await projectRuntimeRows(database, this.originalTables, this.tables, [...this.resources.values()].flatMap(resource => resource.documents));
      return await super.query<T>(fields, sql, parameters);
    } finally {
      await projectRuntimeRows(database, this.tables, this.originalTables, [...this.originalResources.values()].flatMap(resource => resource.documents));
    }
  }
  patch(table: string, primary: Record<string, unknown>, fields: Record<string, unknown>): void {
    const row = this.tables.get(table)?.get(dataKey(table, primary)); if (!row) throw new InvalidProtectedData();
    patchDataRecord(row, fields, this.live, (document, path, value) => {
      const changed = this.editable(document); setDataPath(changed.value, path, structuredClone(value));
    });
    this.rebuild();
  }
  edit<T>(request: DataRequest<T>, id: string, change: (value: T) => void): void {
    this.live(); const resource = this.resources.get(dataAreaKey(request.area));
    if (!resource || resource.request.model !== request.model) throw new InvalidProtectedData();
    const document = resource.documents.find(document => document.object.envelope.object === id);
    if (!document) throw new InvalidProtectedData(); change(this.editable(document).value as T); this.rebuild();
  }
  create<T>(request: DataRequest<T>, id: string, value: T): void {
    this.createMany(request, [{ id, value }]);
  }
  createMany<T>(request: DataRequest<T>, objects: readonly { id: string; value: T }[]): void {
    this.live(); const resource = this.resources.get(dataAreaKey(request.area));
    if (!resource || resource.request.model !== request.model) throw new InvalidProtectedData();
    const existing = new Set(resource.documents.map(document => document.object.envelope.object));
    for (const { id, value } of objects) {
      if (!id.startsWith(request.area.prefix) || existing.has(id) || this.changes.has(dataDocumentKey(request.area, id))) throw new InvalidProtectedData();
      const object = { envelope: { object: id, revision: "0" } as DataDocument<T>["object"]["envelope"], value };
      this.changes.set(dataDocumentKey(request.area, id), openDataDocument(request.model, request.area, object));
    }
    this.rebuild();
  }
  private rebuild(): void {
    const resources = new Map(this.resources);
    const grouped = new Map<string, DataDocument<unknown>[]>();
    for (const [id, document] of this.changes) {
      const checked = openDataDocument(document.model, document.area, { ...document.object, value: document.value });
      this.changes.set(id, checked);
      const key = dataAreaKey(document.area), documents = grouped.get(key) ?? []; documents.push(checked); grouped.set(key, documents);
    }
    for (const [key, documents] of grouped) {
      const previous = resources.get(key)!, changed = new Set(documents.map(document => document.object.envelope.object));
      resources.set(key, { ...previous, documents: [...previous.documents.filter(document => !changed.has(document.object.envelope.object)), ...documents], known: new Set([...previous.known, ...changed]) });
    }
    this.resources = resources; this.tables = projectDataRows([...resources.values()].flatMap(resource => resource.documents));
  }
  private editable(document: DataDocument<unknown>): DataDocument<unknown> {
    this.live(); const key = dataDocumentKey(document.area, document.object.envelope.object);
    let changed = this.changes.get(key);
    if (!changed) { changed = { ...document, value: structuredClone(document.value) }; this.changes.set(key, changed); }
    return changed;
  }
}

/** One queue, verified snapshot set and RAM database for the application. The
 * storage port owns crypto; ordinary business functions only edit typed data. */
export class DataRuntime {
  private resources = new Map<string, Resource>();
  private projectedResources = new Map<string, Resource>();
  private tables: DataTables = new Map();
  private pending: Promise<unknown> = Promise.resolve();
  private database?: Promise<BusinessDatabase>;
  private controller = new AbortController();
  private generation = 0;
  private projectedGeneration = -1;
  private stale = new Set<string>();
  private closed = false;
  private listeners = new Set<(domains?: ReadonlySet<string>) => void>();
  constructor(private readonly storage: DataStorage, private readonly context: () => void,
    private driver?: () => Promise<DuckDriver>) {}
  private live = () => { this.controller.signal.throwIfAborted(); this.context(); if (this.closed) throw new InvalidProtectedData(); };
  configureDriver(driver?: () => Promise<DuckDriver>): void {
    this.live();
    // Facades may wrap the same factory independently. The first configured
    // driver belongs to the shared runtime, never to a later individual lease.
    if (!driver || this.driver || this.database) return;
    this.driver = driver;
  }
  listen(listener: (domains?: ReadonlySet<string>) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  revalidate(domains?: ReadonlySet<string>): void {
    for (const [key, resource] of this.resources) if (!domains || domains.has(resource.request.area.domain)) this.stale.add(key);
  }
  invalidate(domains?: ReadonlySet<string>, minimumHeads?: ReadonlyMap<string, string>): void {
    if (domains && minimumHeads && [...domains].every(domain => {
      const head = minimumHeads.get(domain), current = [...this.resources.values()].filter(resource => resource.request.area.domain === domain);
      return head !== undefined && /^(0|[1-9]\d*)$/.test(head) && current.length && current.every(resource => BigInt(resource.head) >= BigInt(head));
    })) return;
    this.generation++;
    for (const [key, resource] of this.resources) if (!domains || domains.has(resource.request.area.domain)) this.resources.delete(key);
    if (!domains) {
      this.projectedResources.clear(); this.tables.clear(); const previous = this.database; this.database = undefined;
      void previous?.then(database => database.close()).catch(() => undefined);
    }
    for (const listener of this.listeners) listener(domains);
  }
  private queue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.pending.then(async () => { this.live(); const value = await work(); this.live(); return value; });
    this.pending = result.catch(() => undefined); return result;
  }
  private db(): Promise<BusinessDatabase> { return this.database ??= (async () => createBusinessDatabase(await this.driver?.(), true))(); }
  read<T>(requests: readonly DataRequest[], work: (view: DataView) => T | Promise<T>): Promise<T> {
    return this.queue(async () => {
      for (let attempt = 0; ; attempt++) {
        try { await this.load(requests); break; }
        catch (error) {
          if (!isWriteConflict(error) || attempt >= 2) throw error;
          this.invalidate(new Set(requests.map(request => request.area.domain)));
        }
      }
      const generation = this.generation;
      let active = true;
      const view = new DataView(this.projectedResources, this.tables, () => { this.live(); if (!active) throw new InvalidProtectedData(); if (generation !== this.generation) throw new ProtectedWriteConflict(); }, () => this.db());
      try { return await work(view); } finally { active = false; }
    });
  }
  private async load(input: readonly DataRequest[], opened?: Map<string, DataCollection>): Promise<void> {
    const merged = new Map<string, DataRequest>();
    for (const request of input) {
      const key = dataAreaKey(request.area), previous = merged.get(key);
      if (request.ids && (request.ids.length > 40_001 || new Set(request.ids).size !== request.ids.length || request.ids.some(id => !id.startsWith(request.area.prefix)))) throw new InvalidProtectedData();
      if (previous && (previous.model !== request.model || previous.area.scope !== request.area.scope || previous.area.facet !== request.area.facet)) throw new InvalidProtectedData();
      merged.set(key, previous ? { ...request, ids: previous.ids && request.ids ? [...new Set([...previous.ids, ...request.ids])] : undefined } : request);
    }
    const requests = [...merged.values()];
    if (!opened && this.projectedGeneration === this.generation && [...this.projectedResources.keys()].every(key => !this.stale.has(key)) && requests.every(request => {
      const key = dataAreaKey(request.area), resource = this.resources.get(key);
      return !this.stale.has(key) && resource?.request.model === request.model && (resource.complete || request.ids !== undefined && request.ids.every(id => resource.known.has(id)));
    })) return;
    const generation = this.generation, next = new Map(this.resources), reads = opened ?? new Map<string, DataCollection>();
    const open = requests.length ? await this.storage.open(this.controller.signal) : null;
    try {
      for (const [key, resource] of next) if (open?.readable && !open.readable(resource.request.area)) next.delete(key);
      const heads = new Map<string, string>();
      for (const request of requests) {
        this.live(); const key = dataAreaKey(request.area), previous = next.get(key);
        if (previous && (previous.request.model !== request.model || previous.request.area.scope !== request.area.scope || previous.request.area.facet !== request.area.facet)) throw new InvalidProtectedData();
        const collection = open!(request.area); reads.set(key, collection);
        let resource: Resource;
        const permissions = Object.fromEntries((["read", "create", "update", "delete"] as const).map(action => [action, collection.can(action)])) as Record<DataAction, boolean>;
        const unchangedPermissions = previous && (["read", "create", "update", "delete"] as const).every(action => previous.permissions[action] === permissions[action]);
        if (request.ids !== undefined) {
          const head = await collection.inspect(undefined, request.ids[0]), same = previous?.head === head;
          const missing = same ? request.ids.filter(id => !previous.complete && !previous.known.has(id)) : request.ids;
          const objects = await collection.selected(missing); this.live();
          const incoming = objects.map(object => openDataDocument(request.model, request.area, object));
          resource = same && !missing.length ? unchangedPermissions ? previous : { ...previous, permissions } : { request: { model: request.model, area: request.area }, head, permissions, complete: same && previous.complete,
            known: new Set([...(same ? previous.known : []), ...request.ids]), documents: [...(same ? previous.documents : []), ...incoming] };
        } else {
          const objects = previous?.complete ? await collection.readIfChanged(previous.head) : await collection.read(); this.live();
          resource = objects === null ? unchangedPermissions ? previous! : { ...previous!, permissions } : { request: { model: request.model, area: request.area }, head: collection.snapshot(), permissions, complete: true,
            documents: objects.map(object => openDataDocument(request.model, request.area, object)), known: new Set(objects.map(object => object.envelope.object)) };
        }
        const prior = heads.get(request.area.domain);
        if (prior !== undefined && prior !== resource.head) throw new ProtectedWriteConflict();
        heads.set(request.area.domain, resource.head); next.set(key, resource);
      }
      // Refreshing one part of a domain invalidates any other old partial view.
      for (const [key, resource] of next) if (heads.has(resource.request.area.domain) && heads.get(resource.request.area.domain) !== resource.head) next.delete(key);
      for (const [key, collection] of reads) {
        const resource = next.get(key); if (!resource) throw new ProtectedWriteConflict();
        if (merged.get(key)?.ids !== undefined) await collection.inspect(resource.head, merged.get(key)!.ids![0]);
        else if (await collection.readIfChanged(resource.head) !== null) throw new ProtectedWriteConflict();
      }
      this.live(); if (generation !== this.generation) throw new ProtectedWriteConflict();
      // A soft refresh may revalidate only part of an earlier transaction.
      // Keep other snapshots for cheap head comparison, but do not merge their
      // stale rows into the verified view or prospective business constraints.
      const fresh = new Map([...next].filter(([key]) => merged.has(key) || !this.stale.has(key)));
      const documents = [...fresh.values()].flatMap(resource => resource.documents), tables = projectDataRows(documents);
      const changed = this.projectedGeneration !== generation || fresh.size !== this.projectedResources.size || [...fresh].some(([key, value]) => this.projectedResources.get(key) !== value);
      if (changed && (this.tables.size || tables.size)) await projectRuntimeRows(await this.db(), this.tables, tables, documents); this.live();
      if (generation !== this.generation) throw new ProtectedWriteConflict();
      if (changed) this.generation++;
      this.resources = next; this.projectedResources = fresh; this.tables = tables; this.projectedGeneration = this.generation;
      for (const request of requests) this.stale.delete(dataAreaKey(request.area));
    } finally { if (!opened) for (const read of reads.values()) read.close(); }
  }
  async transaction<T>(requests: readonly DataRequest[], work: (tx: DataTransaction) => T | Promise<T>, options: TransactionOptions = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.transact(requests, work, options); }
      catch (error) {
        if (!isWriteConflict(error) || attempt >= (options.retries ?? 0)) throw error;
        this.invalidate(new Set(requests.map(request => request.area.domain)));
      }
    }
  }
  private transact<T>(requests: readonly DataRequest[], work: (tx: DataTransaction) => T | Promise<T>, options: TransactionOptions): Promise<T> {
    return this.queue(async () => {
      const prepared = await this.prepareWork(requests, work);
      try {
        if (prepared.groups.length) {
          await this.storage.commit(prepared.groups, prepared.guards, this.controller.signal);
          this.live(); options.verified?.(prepared.versions);
        }
        return prepared.value;
      } finally { prepared.close(); }
    });
  }
  /** Compose a business command with other prepared commands in one atomic
   * publication. The caller owns closing the returned groups, also on failure. */
  prepare<T>(requests: readonly DataRequest[], work: (tx: DataTransaction) => T | Promise<T>, guards: readonly PreparedWrites["head"][] = []): Promise<PreparedData<T>> {
    return this.queue(async () => {
      const prepared = await this.prepareWork(requests, work);
      try {
        const heads = new Map(prepared.groups.map(group => [group.head.domain, group.head.sequence]));
        const extra = new Map(prepared.guards.map(head => [head.domain, head.sequence]));
        for (const head of guards) {
          const previous = heads.get(head.domain) ?? extra.get(head.domain);
          if (previous !== undefined && previous !== head.sequence) throw new ProtectedWriteConflict();
          if (!heads.has(head.domain)) extra.set(head.domain, head.sequence);
        }
        return { ...prepared, guards: [...extra].map(([domain, sequence]) => ({ domain, sequence })) };
      } catch (error) { prepared.close(); throw error; }
    });
  }
  private async prepareWork<T>(requests: readonly DataRequest[], work: (tx: DataTransaction) => T | Promise<T>): Promise<PreparedData<T>> {
    const reads = new Map<string, DataCollection>(), changedDomains = new Set<string>();
    let active = true, retained = false, closed = false;
    const close = () => {
      if (closed) return; closed = true;
      if (changedDomains.size) this.invalidate(changedDomains);
      for (const read of reads.values()) read.close();
    };
    try {
      await this.load(requests, reads); const generation = this.generation;
      const tx = new DataTransaction(this.projectedResources, this.tables, () => { this.live(); if (!active) throw new InvalidProtectedData(); if (generation !== this.generation) throw new ProtectedWriteConflict(); }, () => this.db(),
        (request, action) => reads.get(dataAreaKey(request.area))?.can(action) ?? false);
      const result = await work(tx); this.live();
      const changes = tx.snapshotChanges(); active = false;
      if (!changes.size) { retained = true; return { value: result, groups: [], guards: [], versions: [], close }; }
      const next = new Map(this.projectedResources), groupedChanges = new Map<string, DataDocument<unknown>[]>();
      for (const changed of changes.values()) {
        const key = dataAreaKey(changed.area); if (!reads.has(key)) throw new InvalidProtectedData();
        const checked = openDataDocument(changed.model, changed.area, { ...changed.object, value: changed.value });
        if (!next.get(key)!.complete && checked.sources.some(source => {
          const table = tableDefinition(source.table); return table.constraints.some(constraint => constraint.kind === "u") || table.uniqueIndexes.length > 0;
        })) throw new UnloadedDataField();
        changes.set(dataDocumentKey(changed.area, changed.object.envelope.object), checked);
        const group = groupedChanges.get(key) ?? []; group.push(checked); groupedChanges.set(key, group); changedDomains.add(changed.area.domain);
      }
      for (const [key, documents] of groupedChanges) {
        const previous = next.get(key)!, changed = new Set(documents.map(document => document.object.envelope.object));
        next.set(key, { ...previous, documents: [...previous.documents.filter(document => !changed.has(document.object.envelope.object)), ...documents], known: new Set([...previous.known, ...changed]) });
      }
      const documents = [...next.values()].flatMap(resource => resource.documents), tables = projectDataRows(documents);
      // Validate the prospective state; rollback the local projection before
      // network publication. Nothing speculative is visible to other callers.
      if (this.tables.size || tables.size) {
        const database = await this.db();
        try { await projectRuntimeRows(database, this.tables, tables, documents); }
        finally { await projectRuntimeRows(database, tables, this.tables, [...this.projectedResources.values()].flatMap(resource => resource.documents)); }
      }
      this.live(); if (generation !== this.generation) throw new ProtectedWriteConflict();
      const grouped = new Map<string, PreparedWrites>(), heads = new Map<string, string>();
      for (const [key, read] of reads) {
        const resource = this.resources.get(key)!, domain = resource.request.area.domain;
        const previous = heads.get(domain); if (previous && previous !== read.snapshot()) throw new ProtectedWriteConflict(); heads.set(domain, read.snapshot());
      }
      const changed = [...changes.values()];
      for (let offset = 0; offset < changed.length; offset += 16) {
        const part = changed.slice(offset, offset + 16), packets = await Promise.all(part.map(document => reads.get(dataAreaKey(document.area))!.packet(document.object.envelope.object, document.value, document.object.envelope.revision === "0" ? undefined : document.object.envelope)));
        this.live(); if (generation !== this.generation) throw new ProtectedWriteConflict();
        for (const packet of packets) {
          const document = changes.get(JSON.stringify([packet.domain, packet.envelope.object]))!, read = reads.get(dataAreaKey(document.area))!;
          let group = grouped.get(packet.domain);
          if (!group) { group = { packets: [], head: { domain: packet.domain, sequence: read.snapshot() }, verify: async () => true, close }; grouped.set(packet.domain, group); }
          group.packets.push(packet);
        }
      }
      for (const group of grouped.values()) group.verify = async () => {
        this.live(); if (closed) throw new InvalidProtectedData();
        const verified = group.packets.length >= 64 && this.storage.verifyPublished ? await this.storage.verifyPublished(group.packets, this.controller.signal) : new Set<string>();
        for (const packet of group.packets) {
          if (verified.has(packet.envelope.object)) continue;
          const changed = changes.get(JSON.stringify([packet.domain, packet.envelope.object]))!;
          const read = reads.get(dataAreaKey(changed.area))!;
          const object = await read.get(packet.envelope.object); this.live(); if (closed) throw new InvalidProtectedData();
          if (object.envelope.signature !== packet.envelope.signature) return false;
          openDataDocument(changed.model, changed.area, object);
        }
        return true;
      };
      this.live(); if (generation !== this.generation) throw new ProtectedWriteConflict();
      retained = true;
      return { value: result, groups: [...grouped.values()],
        guards: [...heads].filter(([domain]) => !grouped.has(domain)).map(([domain, sequence]) => ({ domain, sequence })),
        versions: [...grouped.values()].flatMap(group => group.packets.map(packet => ({ domain: packet.domain, id: packet.envelope.object, revision: packet.envelope.revision, signature: packet.envelope.signature }))), close };
    } finally { active = false; if (!retained) close(); }
  }
  remove(request: DataRequest, id: string): Promise<void> {
    return this.queue(async () => {
      const reads = new Map<string, DataCollection>();
      try {
        await this.load([request], reads);
        const resource = this.resources.get(dataAreaKey(request.area))!, document = resource.documents.find(document => document.object.envelope.object === id);
        const collection = reads.get(dataAreaKey(request.area))!;
        // The storage port must verify a signed deletion proof when retrying an
        // already removed object. Mere absence is not evidence of our deletion.
        await collection.remove(id, document?.object.envelope);
        const remaining = request.ids ? await collection.selected([id]) : await collection.read(); this.live();
        if (remaining.some(object => object.envelope.object === id)) throw new ProtectedWriteConflict();
      } finally { this.invalidate(new Set([request.area.domain])); for (const read of reads.values()) read.close(); }
    });
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true; this.controller.abort(); const database = this.database;
    this.invalidate(); this.resources.clear(); this.projectedResources.clear(); this.tables.clear(); this.stale.clear(); this.listeners.clear();
    await this.pending; if (database) await (await database).close();
  }
}
