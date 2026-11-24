import { createSerialQueue } from "@sortsys/zerotrust";
import {
  InvalidProtectedData,
  TOMBSTONE_FORMAT,
} from "@sortsys/zerotrust/sortsys";
import {
  isWriteConflict,
  ProtectedWriteConflict,
  type PreparedWrites,
} from "../atomicWrites";
import {
  createBusinessDatabase,
  type BusinessDatabase,
  type DuckDriver,
} from "../database";
import type { Collection, CollectionPageRequest } from "../protectedObjects";
import {
  dataAreaKey,
  dataDocumentKey,
  dataKey,
  modelTables,
  openDataDocument,
  setDataPath,
  type DataDocument,
  type DataModel,
} from "./model";
import {
  DataRow,
  patchDataRecord,
  projectDataRows,
  type RowProjection,
  UnloadedDataField,
} from "./rows";
import { tableDefinition } from "../schema";
import { projectRuntimeRows, type DataTables } from "./sql";
import type { DataCollection, DataCollections, DataStorage } from "./storage";
import { mapConcurrent } from "./concurrentReads";

export type DataRequest<T = unknown> = {
  model: DataModel<T>;
  area: Collection;
  ids?: readonly string[];
};
export type DataVersion = {
  domain: string;
  id: string;
  revision: string;
  signature: string;
};
type TransactionOptions = {
  signal?: AbortSignal;
  retries?: number;
  verified?: (versions: readonly DataVersion[]) => void;
};
type DataAction = "read" | "create" | "update" | "delete" | "approve";
const DATA_ACTIONS: readonly DataAction[] = [
  "read",
  "create",
  "update",
  "delete",
  "approve",
];
type DataPermissions = Readonly<Record<DataAction, boolean>>;
export type PreparedData<T> = {
  value: T;
  groups: PreparedWrites[];
  guards: PreparedWrites["head"][];
  versions: readonly DataVersion[];
  close(): void;
};

export type DataCommand<T> = {
  requests: readonly DataRequest[];
  apply(tx: DataTransaction): T;
};

type Resource = {
  request: DataRequest;
  head: string;
  documents: DataDocument<unknown>[];
  complete: boolean;
  known: ReadonlySet<string>;
  permissions: DataPermissions;
};
type SnapshotCache = Map<symbol, { sources: Resource[]; value: unknown }>;
type DirectoryRead = {
  requests: readonly DataRequest[];
  run(): Promise<void>;
  reject(reason: unknown): void;
};

function withPermissions(
  resource: Resource,
  permissions: DataPermissions,
): Resource {
  const unchanged = DATA_ACTIONS.every(
    (action) => resource.permissions[action] === permissions[action],
  );
  if (unchanged) return resource;
  return { ...resource, permissions };
}
export class DataView {
  constructor(
    protected resources: ReadonlyMap<string, Resource>,
    protected tables: DataTables,
    protected readonly live: () => void,
    protected readonly database: () => Promise<BusinessDatabase>,
    private readonly snapshotCache: SnapshotCache = new Map(),
  ) {}
  /** Keep a derived view only while its complete, verified source snapshots
   * still match. The caller owns the cache key and must keep the value private. */
  derive<T>(
    key: symbol,
    requests: readonly DataRequest[],
    build: () => T,
  ): T {
    this.live();
    const sources = requests.map((request) => {
      const source = this.resources.get(dataAreaKey(request.area));
      if (!source?.complete || source.request.model !== request.model)
        throw new InvalidProtectedData();
      return source;
    });
    const cached = this.snapshotCache.get(key);
    if (
      cached?.sources.length === sources.length &&
      sources.every((source, index) => source === cached.sources[index])
    )
      return cached.value as T;
    const value = build();
    this.live();
    this.snapshotCache.set(key, { sources, value });
    return value;
  }
  can(request: DataRequest, action: DataAction): boolean {
    this.live();
    const resource = this.resources.get(dataAreaKey(request.area));
    if (!resource || resource.request.model !== request.model)
      throw new InvalidProtectedData();
    return resource.permissions[action];
  }
  documents<T>(request: DataRequest<T>): {
    id: string;
    revision: string;
    signature: string | undefined;
    value: T;
  }[] {
    this.live();
    const resource = this.resources.get(dataAreaKey(request.area));
    if (!resource || resource.request.model !== request.model)
      throw new InvalidProtectedData();
    const selected = request.ids && new Set(request.ids);
    if (
      !resource.complete &&
      (!selected || [...selected].some((id) => !resource.known.has(id)))
    )
      throw new InvalidProtectedData();
    return resource.documents
      .filter(
        (document) =>
          !selected || selected.has(document.object.envelope.object),
      )
      .map((document) => ({
        id: document.object.envelope.object,
        revision: document.object.envelope.revision,
        signature: document.object.envelope.signature,
        value: structuredClone(document.value) as T,
      }));
  }
  head(request: DataRequest): { domain: string; sequence: string } {
    this.live();
    const resource = this.resources.get(dataAreaKey(request.area));
    if (!resource || resource.request.model !== request.model)
      throw new InvalidProtectedData();
    return { domain: request.area.domain, sequence: resource.head };
  }
  rows(table: string): DataRow[] {
    this.live();
    return [...(this.tables.get(table)?.values() ?? [])].map(
      (row) => new DataRow(row, this.live),
    );
  }
  row(table: string, primary: Record<string, unknown>): DataRow {
    this.live();
    const row = this.tables.get(table)?.get(dataKey(table, primary));
    if (!row) throw new InvalidProtectedData();
    return new DataRow(row, this.live);
  }
  async query<T>(
    fields: Readonly<Record<string, readonly string[]>>,
    sql: string,
    parameters?: unknown[],
  ): Promise<T[]> {
    this.live();
    for (const [table, columns] of Object.entries(fields)) {
      const declared = [...this.resources.values()].some(
        (resource) =>
          modelTables(resource.request.model, resource.request.area)?.includes(
            table,
          ) ||
          resource.documents.some((document) =>
            document.sources.some((source) => source.table === table),
          ),
      );
      if (!declared) throw new UnloadedDataField();
      for (const resource of this.resources.values())
        if (!resource.complete) {
          const known = modelTables(
            resource.request.model,
            resource.request.area,
          ) ?? [
            ...new Set(
              resource.documents.flatMap((document) =>
                document.sources.map((source) => source.table),
              ),
            ),
          ];
          if (
            known.includes(table) ||
            (!known.length && resource.request.model.tables === undefined)
          )
            throw new UnloadedDataField();
        }
      for (const row of this.rows(table)) row.pick(columns);
    }
    const result = await (await this.database()).query<T>(sql, parameters);
    this.live();
    return result.rows;
  }
}
export class DataTransaction extends DataView {
  constructor(
    resources: ReadonlyMap<string, Resource>,
    tables: DataTables,
    live: () => void,
    database: () => Promise<BusinessDatabase>,
    private readonly permitted: (
      request: DataRequest,
      action: DataAction,
    ) => boolean,
    private readonly project?: RowProjection,
  ) {
    super(resources, tables, live, database);
  }
  require(request: DataRequest, action: DataAction): void {
    this.live();
    if (!this.permitted(request, action)) throw new InvalidProtectedData();
  }
  expect(
    request: DataRequest,
    id: string,
    expected: { signature?: string; revision?: string },
  ): void {
    const document = this.documents(request).find(
      (document) => document.id === id,
    );
    if (
      !document ||
      (expected.signature !== undefined &&
        expected.signature !== document.signature) ||
      (expected.revision !== undefined &&
        expected.revision !== document.revision)
    )
      throw new ProtectedWriteConflict();
  }
  private readonly changes = new Map<string, DataDocument<unknown>>();
  private readonly deletions = new Map<string, DataDocument<unknown>>();
  snapshotChanges(): Map<string, DataDocument<unknown>> {
    this.live();
    return new Map(
      [...this.changes].map(([key, document]) => [
        key,
        openDataDocument(document.model, document.area, {
          ...document.object,
          value: document.value,
        }),
      ]),
    );
  }
  snapshotDeletions(): Map<string, DataDocument<unknown>> {
    this.live();
    return new Map(this.deletions);
  }
  private readonly originalResources = this.resources;
  private readonly originalTables = this.tables;
  override async query<T>(
    fields: Readonly<Record<string, readonly string[]>>,
    sql: string,
    parameters?: unknown[],
  ): Promise<T[]> {
    if (!this.changes.size) return super.query<T>(fields, sql, parameters);
    const database = await this.database();
    try {
      await projectRuntimeRows(
        database,
        this.originalTables,
        this.tables,
        [...this.resources.values()].flatMap((resource) => resource.documents),
      );
      return await super.query<T>(fields, sql, parameters);
    } finally {
      await projectRuntimeRows(
        database,
        this.tables,
        this.originalTables,
        [...this.originalResources.values()].flatMap(
          (resource) => resource.documents,
        ),
      );
    }
  }
  patch(
    table: string,
    primary: Record<string, unknown>,
    fields: Record<string, unknown>,
  ): void {
    const row = this.tables.get(table)?.get(dataKey(table, primary));
    if (!row) throw new InvalidProtectedData();
    patchDataRecord(row, fields, this.live, (document, path, value) => {
      const changed = this.editable(document);
      setDataPath(changed.value, path, structuredClone(value));
    });
    this.rebuild();
  }
  edit<T>(
    request: DataRequest<T>,
    id: string,
    change: (value: T) => void,
  ): void {
    this.live();
    const resource = this.resources.get(dataAreaKey(request.area));
    if (!resource || resource.request.model !== request.model)
      throw new InvalidProtectedData();
    const document = resource.documents.find(
      (document) => document.object.envelope.object === id,
    );
    if (!document) throw new InvalidProtectedData();
    change(this.editable(document).value as T);
    this.rebuild();
  }
  delete(request: DataRequest, id: string): void {
    this.require(request, "delete");
    const resource = this.resources.get(dataAreaKey(request.area));
    if (!resource || resource.request.model !== request.model)
      throw new InvalidProtectedData();
    const document = resource.documents.find(
      (document) => document.object.envelope.object === id,
    );
    if (!document || document.object.envelope.revision === "0")
      throw new InvalidProtectedData();
    const key = dataDocumentKey(request.area, id);
    this.changes.delete(key);
    this.deletions.set(key, document);
    this.rebuild();
  }
  create<T>(request: DataRequest<T>, id: string, value: T): void {
    this.createMany(request, [{ id, value }]);
  }
  createMany<T>(
    request: DataRequest<T>,
    objects: readonly { id: string; value: T }[],
  ): void {
    this.live();
    const resource = this.resources.get(dataAreaKey(request.area));
    if (!resource || resource.request.model !== request.model)
      throw new InvalidProtectedData();
    const existing = new Set(
      resource.documents.map((document) => document.object.envelope.object),
    );
    for (const { id, value } of objects) {
      if (
        !id.startsWith(request.area.prefix) ||
        existing.has(id) ||
        this.changes.has(dataDocumentKey(request.area, id)) ||
        this.deletions.has(dataDocumentKey(request.area, id))
      )
        throw new InvalidProtectedData();
      const object = {
        envelope: {
          object: id,
          revision: "0",
        } as DataDocument<T>["object"]["envelope"],
        value,
      };
      this.changes.set(
        dataDocumentKey(request.area, id),
        openDataDocument(request.model, request.area, object),
      );
    }
    this.rebuild();
  }
  private rebuild(): void {
    const resources = new Map(this.resources);
    const grouped = new Map<string, DataDocument<unknown>[]>();
    for (const [id, document] of this.changes) {
      const checked = openDataDocument(document.model, document.area, {
        ...document.object,
        value: document.value,
      });
      this.changes.set(id, checked);
      const key = dataAreaKey(document.area);
      const documents = grouped.get(key) ?? [];
      documents.push(checked);
      grouped.set(key, documents);
    }
    for (const [key, documents] of grouped) {
      const previous = resources.get(key)!;
      const changed = new Set(
        documents.map((document) => document.object.envelope.object),
      );
      resources.set(key, {
        ...previous,
        documents: [
          ...previous.documents.filter(
            (document) => !changed.has(document.object.envelope.object),
          ),
          ...documents,
        ],
        known: new Set([...previous.known, ...changed]),
      });
    }
    for (const document of this.deletions.values()) {
      const key = dataAreaKey(document.area);
      const previous = resources.get(key)!;
      resources.set(key, {
        ...previous,
        documents: previous.documents.filter(
          (value) =>
            value.object.envelope.object !== document.object.envelope.object,
        ),
      });
    }
    this.resources = resources;
    this.tables = projectDataRows(
      [...resources.values()].flatMap((resource) => resource.documents),
      this.project,
    );
  }
  private editable(document: DataDocument<unknown>): DataDocument<unknown> {
    this.live();
    const key = dataDocumentKey(document.area, document.object.envelope.object);
    if (this.deletions.has(key)) throw new InvalidProtectedData();
    let changed = this.changes.get(key);
    if (!changed) {
      changed = { ...document, value: structuredClone(document.value) };
      this.changes.set(key, changed);
    }
    return changed;
  }
}

/** One queue, verified snapshot set and RAM database for the application. The
 * storage port owns crypto; ordinary business functions only edit typed data. */
export class DataRuntime {
  private resources = new Map<string, Resource>();
  private projectedResources = new Map<string, Resource>();
  private snapshotCache: SnapshotCache = new Map();
  private tables: DataTables = new Map();
  private project?: RowProjection;
  private readonly operations = createSerialQueue(() => this.live());
  private directoryReads?: DirectoryRead[];
  private database?: Promise<BusinessDatabase>;
  private controller = new AbortController();
  private generation = 0;
  private projectedGeneration = -1;
  private stale = new Set<string>();
  private loadingDomains = new Set<string>();
  private closed = false;
  private listeners = new Set<(domains?: ReadonlySet<string>) => void>();
  constructor(
    private readonly storage: DataStorage,
    private readonly context: () => void,
    private driver?: () => Promise<DuckDriver>,
    private readonly loadProjection?: (
      documents: readonly DataDocument<unknown>[],
      signal: AbortSignal,
    ) => Promise<RowProjection | undefined>,
  ) {}
  private live = () => {
    this.controller.signal.throwIfAborted();
    this.context();
    if (this.closed) throw new InvalidProtectedData();
  };
  configureDriver(driver?: () => Promise<DuckDriver>): void {
    this.live();
    // Facades may wrap the same factory independently. The first configured
    // driver belongs to the shared runtime, never to a later individual lease.
    if (!driver || this.driver || this.database) return;
    this.driver = driver;
  }
  listen(listener: (domains?: ReadonlySet<string>) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  revalidate(domains?: ReadonlySet<string>): void {
    for (const [key, resource] of this.resources)
      if (!domains || domains.has(resource.request.area.domain))
        this.stale.add(key);
  }
  invalidate(
    domains?: ReadonlySet<string>,
    minimumHeads?: ReadonlyMap<string, string>,
  ): void {
    if (domains) {
      // A removed resource has already retired its projected rows. Repeated
      // hints for it must not restart another area's load; an in-flight reload
      // of that same area is still protected by loadingDomains below.
      const affected = [...this.resources.values()].some((resource) =>
        domains.has(resource.request.area.domain),
      );
      const loading = [...this.loadingDomains].some((domain) =>
        domains.has(domain),
      );
      if (!affected && !loading) {
        // For example, saving visit preferences must not restart a commercial
        // snapshot. Still notify observers that may begin reading this area.
        for (const listener of this.listeners) listener(domains);
        return;
      }
    }
    if (
      domains &&
      minimumHeads &&
      [...domains].every((domain) => {
        const head = minimumHeads.get(domain);
        const current = [...this.resources.values()].filter(
          (resource) => resource.request.area.domain === domain,
        );
        return (
          head !== undefined &&
          /^(0|[1-9]\d*)$/.test(head) &&
          current.length &&
          current.every((resource) => BigInt(resource.head) >= BigInt(head))
        );
      })
    )
      return;
    this.generation++;
    for (const [key, resource] of this.resources)
      if (!domains || domains.has(resource.request.area.domain))
        this.resources.delete(key);
    if (!domains) {
      this.snapshotCache.clear();
      this.projectedResources.clear();
      this.tables.clear();
      this.project = undefined;
      const previous = this.database;
      this.database = undefined;
      void previous
        ?.then((database) => database.close())
        .catch(() => undefined);
    } else {
      for (const [key, cached] of this.snapshotCache)
        if (
          cached.sources.some((source) => domains.has(source.request.area.domain))
        )
          this.snapshotCache.delete(key);
    }
    for (const listener of this.listeners) listener(domains);
  }
  private db(): Promise<BusinessDatabase> {
    if (this.database) return this.database;
    const opening = (async () =>
      createBusinessDatabase(await this.driver?.(), true))();
    this.database = opening;
    void opening.catch(() => {
      if (this.database === opening) this.database = undefined;
    });
    return opening;
  }
  read<T>(
    requests: readonly DataRequest[],
    work: (view: DataView) => T | Promise<T>,
    collections?: DataCollections,
    options?: { batchDirectory?: boolean },
  ): Promise<T> {
    if (options?.batchDirectory && !collections)
      return this.readDirectory(requests, work);
    return this.operations.run(async () => {
      await this.loadCurrent(requests, undefined, collections);
      return this.withView(work);
    });
  }
  private async withView<T>(
    work: (view: DataView) => T | Promise<T>,
    allowSql = true,
  ): Promise<T> {
    const generation = this.generation;
    let active = true;
    const assertCurrent = () => {
      this.live();
      if (!active) throw new InvalidProtectedData();
      if (generation !== this.generation) throw new ProtectedWriteConflict();
    };
    const view = new DataView(
      this.projectedResources,
      this.tables,
      assertCurrent,
      () => {
        if (!allowSql) throw new InvalidProtectedData();
        return this.db();
      },
      this.snapshotCache,
    );
    try {
      const value = await work(view);
      assertCurrent();
      return value;
    } finally {
      active = false;
    }
  }
  /** Directory views that are waiting for the same runtime can verify their
   * objects in one load. A denied or broken area only fails its own search. */
  private async readDirectory<T>(
    requests: readonly DataRequest[],
    work: (view: DataView) => T | Promise<T>,
  ): Promise<T> {
    this.live();
    if (
      requests.every((request) => request.ids === undefined) &&
      this.hasCurrent(requests)
    ) {
      // A warm directory uses verified RAM data. It can finish while another
      // area is being fetched or materialized in the shared SQL database.
      const generation = this.generation;
      const value = await this.withView(work, false);
      this.live();
      if (this.generation !== generation || !this.hasCurrent(requests))
        throw new ProtectedWriteConflict();
      return value;
    }
    return new Promise<T>((resolve, reject) => {
      const entry: DirectoryRead = {
        requests,
        run: async () => {
          try {
            await this.loadCurrent(requests);
            const value = await this.withView(work);
            this.live();
            resolve(value);
          } catch (error) {
            reject(error);
          }
        },
        reject,
      };
      if (this.directoryReads) {
        this.directoryReads.push(entry);
        return;
      }
      const batch = [entry];
      this.directoryReads = batch;
      void this.operations.run(async () => {
        this.directoryReads = undefined;
        const missing: DirectoryRead[] = [];
        for (const read of batch) {
          if (this.hasCurrent(read.requests)) await read.run();
          else missing.push(read);
        }
        if (missing.length > 1) {
          try {
            await this.loadCurrent(missing.flatMap((read) => read.requests));
          } catch {
            this.live();
            // Each authorized category still gets its own verified load.
          }
        }
        for (const read of missing) await read.run();
      }).catch((error) => {
        if (this.directoryReads === batch) this.directoryReads = undefined;
        for (const read of batch) read.reject(error);
      });
    });
  }
  /** Retry only snapshot acquisition. Business callbacks have not run yet;
   * conflicts during their execution or publication remain the caller's concern. */
  private async loadCurrent(
    requests: readonly DataRequest[],
    opened?: Map<string, DataCollection>,
    supplied?: DataCollections,
  ): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.load(requests, opened, supplied);
        return;
      } catch (error) {
        if (!isWriteConflict(error) || attempt >= 2) throw error;
        if (opened) {
          for (const collection of opened.values()) collection.close();
          opened.clear();
        }
        supplied = undefined;
        this.invalidate(
          new Set(requests.map((request) => request.area.domain)),
        );
      }
    }
  }
  private hasCurrent(requests: readonly DataRequest[]): boolean {
    if (this.projectedGeneration !== this.generation) return false;
    for (const key of this.projectedResources.keys()) {
      if (this.stale.has(key)) return false;
    }
    return requests.every((request) => {
      const key = dataAreaKey(request.area);
      const resource = this.resources.get(key);
      return (
        !this.stale.has(key) &&
        resource?.request.model === request.model &&
        (resource.complete ||
          (request.ids !== undefined &&
            request.ids.every((id) => resource.known.has(id))))
      );
    });
  }
  private async load(
    input: readonly DataRequest[],
    opened?: Map<string, DataCollection>,
    supplied?: DataCollections,
  ): Promise<void> {
    const merged = new Map<string, DataRequest>();
    for (const request of input) {
      const key = dataAreaKey(request.area);
      const previous = merged.get(key);
      if (
        request.ids &&
        (request.ids.length > 40_001 ||
          new Set(request.ids).size !== request.ids.length ||
          request.ids.some((id) => !id.startsWith(request.area.prefix)))
      )
        throw new InvalidProtectedData();
      if (
        previous &&
        (previous.model !== request.model ||
          previous.area.scope !== request.area.scope ||
          previous.area.facet !== request.area.facet)
      )
        throw new InvalidProtectedData();
      if (!previous) {
        merged.set(key, request);
        continue;
      }

      // An unrestricted request takes precedence over selected object IDs.
      let ids: string[] | undefined;
      if (previous.ids && request.ids) {
        ids = [...new Set([...previous.ids, ...request.ids])];
      }
      merged.set(key, { ...request, ids });
    }
    const requests = [...merged.values()];
    if (!opened && !supplied && this.hasCurrent(requests)) return;
    const generation = this.generation;
    const next = new Map(this.resources);
    const reads = opened ?? new Map<string, DataCollection>();
    let open: DataCollections | null = null;
    const initial = requests.map((request): CollectionPageRequest => {
      if (request.ids !== undefined)
        return { area: request.area, headOnly: true };
      const previous = next.get(dataAreaKey(request.area));
      return {
        area: request.area,
        known: previous?.complete ? previous.head : undefined,
      };
    });
    this.loadingDomains = new Set(
      requests.map((request) => request.area.domain),
    );
    try {
      if (requests.length) {
        // readable() below checks every retained resource. Include those areas
        // as well as the new requests; a narrow inventory must not evict an
        // unrelated cached area merely because it was omitted from the read.
        const domains = [
          ...new Set([
            ...requests.map((request) => request.area.domain),
            ...[...next.values()].map(
              (resource) => resource.request.area.domain,
            ),
          ]),
        ];
        open =
          supplied ??
          (await this.storage.open(this.controller.signal, domains, initial));
      }
      const needsDatabase = requests.some(
        ({ area, model }) =>
          modelTables(model, area)?.length && open?.readable?.(area),
      );
      // Prepare the empty schema while authorized objects are being verified.
      // The projection below still waits for their final snapshot checks.
      const database = needsDatabase ? this.db() : undefined;
      void database?.catch(() => undefined);
      await open?.prefetch?.(initial);
      for (const [key, resource] of next)
        if (open?.readable && !open.readable(resource.request.area))
          next.delete(key);
      const heads = new Map<string, string>();
      await mapConcurrent(requests, 4, async (request) => {
        this.live();
        const key = dataAreaKey(request.area);
        const previous = next.get(key);
        if (
          previous &&
          (previous.request.model !== request.model ||
            previous.request.area.scope !== request.area.scope ||
            previous.request.area.facet !== request.area.facet)
        )
          throw new InvalidProtectedData();
        const collection = open!(request.area);
        reads.set(key, collection);
        let resource: Resource;
        const permissions = Object.fromEntries(
          DATA_ACTIONS.map((action) => [action, collection.can(action)]),
        ) as Record<DataAction, boolean>;
        if (request.ids !== undefined) {
          const head = await collection.inspect();
          const unchangedHead = previous?.head === head;
          const missingIds = unchangedHead
            ? request.ids.filter(
                (id) => !previous.complete && !previous.known.has(id),
              )
            : request.ids;
          const objects = await collection.selected(missingIds);
          this.live();
          const incomingDocuments = objects.map((object) =>
            openDataDocument(request.model, request.area, object),
          );
          if (unchangedHead && missingIds.length === 0) {
            resource = withPermissions(previous, permissions);
          } else {
            const knownIds = unchangedHead ? previous.known : [];
            const cachedDocuments = unchangedHead ? previous.documents : [];
            resource = {
              request: { model: request.model, area: request.area },
              head,
              permissions,
              complete: unchangedHead && previous.complete,
              known: new Set([...knownIds, ...request.ids]),
              documents: [...cachedDocuments, ...incomingDocuments],
            };
          }
        } else {
          const objects = previous?.complete
            ? await collection.readIfChanged(previous.head)
            : await collection.read();
          this.live();
          if (objects === null) {
            resource = withPermissions(previous!, permissions);
          } else {
            resource = {
              request: { model: request.model, area: request.area },
              head: collection.snapshot(),
              permissions,
              complete: true,
              documents: objects.map((object) =>
                openDataDocument(request.model, request.area, object),
              ),
              known: new Set(objects.map((object) => object.envelope.object)),
            };
          }
        }
        const prior = heads.get(request.area.domain);
        if (prior !== undefined && prior !== resource.head)
          throw new ProtectedWriteConflict();
        heads.set(request.area.domain, resource.head);
        next.set(key, resource);
      });
      // Refreshing one part of a domain invalidates any other old partial view.
      for (const [key, resource] of next)
        if (
          heads.has(resource.request.area.domain) &&
          heads.get(resource.request.area.domain) !== resource.head
        )
          next.delete(key);
      await open?.prefetch?.(
        [...reads.keys()].map((key) => {
          const resource = next.get(key);
          if (!resource) throw new ProtectedWriteConflict();
          return {
            area: resource.request.area,
            snapshot: resource.head,
            headOnly: true,
          };
        }),
      );
      await mapConcurrent([...reads], 4, async ([key, collection]) => {
        const resource = next.get(key);
        if (!resource) throw new ProtectedWriteConflict();
        await collection.inspect(resource.head);
      });
      this.live();
      if (generation !== this.generation) throw new ProtectedWriteConflict();
      // A soft refresh may revalidate only part of an earlier transaction.
      // Keep other snapshots for cheap head comparison, but do not merge their
      // stale rows into the verified view or prospective business constraints.
      const fresh = new Map(
        [...next].filter(([key]) => merged.has(key) || !this.stale.has(key)),
      );
      const documents = [...fresh.values()].flatMap(
        (resource) => resource.documents,
      );
      const changed =
        this.projectedGeneration !== generation ||
        fresh.size !== this.projectedResources.size ||
        [...fresh].some(
          ([key, value]) => this.projectedResources.get(key) !== value,
        );
      const project = changed
        ? await this.loadProjection?.(documents, this.controller.signal)
        : this.project;
      this.live();
      if (generation !== this.generation) throw new ProtectedWriteConflict();
      const tables = changed ? projectDataRows(documents, project) : this.tables;
      if (changed && (this.tables.size || tables.size))
        await projectRuntimeRows(
          await (database ?? this.db()),
          this.tables,
          tables,
          documents,
        );
      this.live();
      if (generation !== this.generation) throw new ProtectedWriteConflict();
      if (changed) this.generation++;
      this.resources = next;
      this.projectedResources = fresh;
      for (const [key, cached] of this.snapshotCache) {
        const retired = cached.sources.some(
          (source) => next.get(dataAreaKey(source.request.area)) !== source,
        );
        if (retired) this.snapshotCache.delete(key);
      }
      this.tables = tables;
      this.project = project;
      this.projectedGeneration = this.generation;
      for (const request of requests)
        this.stale.delete(dataAreaKey(request.area));
    } finally {
      this.loadingDomains.clear();
      if (!opened) for (const read of reads.values()) read.close();
    }
  }
  async transaction<T>(
    requests: readonly DataRequest[],
    work: (tx: DataTransaction) => T | Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.transact(requests, work, options);
      } catch (error) {
        if (!isWriteConflict(error) || attempt >= (options.retries ?? 0))
          throw error;
        this.invalidate(
          new Set(requests.map((request) => request.area.domain)),
        );
      }
    }
  }
  private transact<T>(
    requests: readonly DataRequest[],
    work: (tx: DataTransaction) => T | Promise<T>,
    options: TransactionOptions,
  ): Promise<T> {
    return this.operations.run(async () => {
      const signals = [this.controller.signal];
      if (options.signal) signals.push(options.signal);
      const signal = AbortSignal.any(signals);
      signal.throwIfAborted();
      const prepared = await this.prepareWork(requests, work);
      try {
        signal.throwIfAborted();
        if (prepared.groups.length) {
          await this.storage.commit(prepared.groups, prepared.guards, signal);
          signal.throwIfAborted();
          this.live();
          options.verified?.(prepared.versions);
        }
        return prepared.value;
      } finally {
        prepared.close();
      }
    });
  }
  /** Compose a business command with other prepared commands in one atomic
   * publication. The caller owns closing the returned groups, also on failure. */
  prepare<T>(
    requests: readonly DataRequest[],
    work: (tx: DataTransaction) => T | Promise<T>,
    guards: readonly PreparedWrites["head"][] = [],
  ): Promise<PreparedData<T>> {
    return this.operations.run(async () => {
      const prepared = await this.prepareWork(requests, work);
      try {
        const heads = new Map(
          prepared.groups.map((group) => [
            group.head.domain,
            group.head.sequence,
          ]),
        );
        const extra = new Map(
          prepared.guards.map((head) => [head.domain, head.sequence]),
        );
        for (const head of guards) {
          const previous = heads.get(head.domain) ?? extra.get(head.domain);
          if (previous !== undefined && previous !== head.sequence)
            throw new ProtectedWriteConflict();
          if (!heads.has(head.domain)) extra.set(head.domain, head.sequence);
        }
        return {
          ...prepared,
          guards: [...extra].map(([domain, sequence]) => ({
            domain,
            sequence,
          })),
        };
      } catch (error) {
        prepared.close();
        throw error;
      }
    });
  }
  private async prepareWork<T>(
    requests: readonly DataRequest[],
    work: (tx: DataTransaction) => T | Promise<T>,
  ): Promise<PreparedData<T>> {
    const reads = new Map<string, DataCollection>();
    const changedDomains = new Set<string>();
    let active = true;
    let retained = false;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      if (changedDomains.size) this.invalidate(changedDomains);
      for (const read of reads.values()) read.close();
    };
    try {
      await this.loadCurrent(requests, reads);
      const generation = this.generation;
      const tx = new DataTransaction(
        this.projectedResources,
        this.tables,
        () => {
          this.live();
          if (!active) throw new InvalidProtectedData();
          if (generation !== this.generation)
            throw new ProtectedWriteConflict();
        },
        () => this.db(),
        (request, action) =>
          reads.get(dataAreaKey(request.area))?.can(action) ?? false,
        this.project,
      );
      const result = await work(tx);
      this.live();
      if (generation !== this.generation) throw new ProtectedWriteConflict();
      const heads = new Map<string, string>();
      for (const [key, read] of reads) {
        const resource = this.resources.get(key)!;
        const domain = resource.request.area.domain;
        const previous = heads.get(domain);
        if (previous && previous !== read.snapshot())
          throw new ProtectedWriteConflict();
        heads.set(domain, read.snapshot());
      }
      const changes = tx.snapshotChanges();
      const deletions = tx.snapshotDeletions();
      active = false;
      if (!changes.size && !deletions.size) {
        retained = true;
        return {
          value: result,
          groups: [],
          guards: [...heads].map(([domain, sequence]) => ({
            domain,
            sequence,
          })),
          versions: [],
          close,
        };
      }
      const next = new Map(this.projectedResources);
      const groupedChanges = new Map<string, DataDocument<unknown>[]>();
      for (const changed of changes.values()) {
        const key = dataAreaKey(changed.area);
        if (!reads.has(key)) throw new InvalidProtectedData();
        const checked = openDataDocument(changed.model, changed.area, {
          ...changed.object,
          value: changed.value,
        });
        if (
          !next.get(key)!.complete &&
          checked.sources.some((source) => {
            const table = tableDefinition(source.table);
            return (
              table.constraints.some((constraint) => constraint.kind === "u") ||
              table.uniqueIndexes.length > 0
            );
          })
        )
          throw new UnloadedDataField();
        changes.set(
          dataDocumentKey(changed.area, changed.object.envelope.object),
          checked,
        );
        const group = groupedChanges.get(key) ?? [];
        group.push(checked);
        groupedChanges.set(key, group);
        changedDomains.add(changed.area.domain);
      }
      for (const [key, documents] of groupedChanges) {
        const previous = next.get(key)!;
        const changed = new Set(
          documents.map((document) => document.object.envelope.object),
        );
        next.set(key, {
          ...previous,
          documents: [
            ...previous.documents.filter(
              (document) => !changed.has(document.object.envelope.object),
            ),
            ...documents,
          ],
          known: new Set([...previous.known, ...changed]),
        });
      }
      for (const document of deletions.values()) {
        const key = dataAreaKey(document.area);
        const previous = next.get(key);
        if (!previous || !reads.has(key)) throw new InvalidProtectedData();
        next.set(key, {
          ...previous,
          documents: previous.documents.filter(
            (value) =>
              value.object.envelope.object !== document.object.envelope.object,
          ),
        });
        changedDomains.add(document.area.domain);
      }
      const documents = [...next.values()].flatMap(
        (resource) => resource.documents,
      );
      const tables = projectDataRows(documents, this.project);
      // Validate the prospective state; rollback the local projection before
      // network publication. Nothing speculative is visible to other callers.
      if (this.tables.size || tables.size)
        await projectRuntimeRows(await this.db(), this.tables, tables, documents, {
          rollback: true,
        });
      this.live();
      if (generation !== this.generation) throw new ProtectedWriteConflict();
      const grouped = new Map<string, PreparedWrites>();
      const allChanges = new Map([...changes, ...deletions]);
      const changed = [...allChanges.values()];
      for (let offset = 0; offset < changed.length; offset += 16) {
        const part = changed.slice(offset, offset + 16);
        const packets = await Promise.all(
          part.map((document) => {
            const read = reads.get(dataAreaKey(document.area))!;
            const id = document.object.envelope.object;
            if (deletions.has(dataDocumentKey(document.area, id))) {
              return read.tombstone(id, document.object.envelope);
            }
            const previousEnvelope =
              document.object.envelope.revision === "0"
                ? undefined
                : document.object.envelope;
            return read.packet(id, document.value, previousEnvelope);
          }),
        );
        this.live();
        if (generation !== this.generation) throw new ProtectedWriteConflict();
        for (const packet of packets) {
          const document = allChanges.get(
            JSON.stringify([packet.domain, packet.envelope.object]),
          )!;
          const read = reads.get(dataAreaKey(document.area))!;
          let group = grouped.get(packet.domain);
          if (!group) {
            group = {
              packets: [],
              head: { domain: packet.domain, sequence: read.snapshot() },
              verify: async () => true,
              close,
            };
            grouped.set(packet.domain, group);
          }
          group.packets.push(packet);
        }
      }
      for (const group of grouped.values())
        group.verify = async () => {
          this.live();
          if (closed) throw new InvalidProtectedData();
          const verified =
            group.packets.length >= 64 && this.storage.verifyPublished
              ? await this.storage.verifyPublished(
                  group.packets,
                  this.controller.signal,
                )
              : new Set<string>();
          const confirmations = await mapConcurrent(
            group.packets,
            4,
            async (packet) => {
              if (verified.has(packet.envelope.object)) return true;
              const changed = allChanges.get(
                JSON.stringify([packet.domain, packet.envelope.object]),
              )!;
              const read = reads.get(dataAreaKey(changed.area))!;
              const object = await read.get(packet.envelope.object);
              this.live();
              if (closed) throw new InvalidProtectedData();
              if (object.envelope.signature !== packet.envelope.signature)
                return false;
              if (
                (packet.recipientKey || object.recipientAccess) &&
                object.recipientAccess?.access.signature !==
                  packet.resourceAccess?.signature
              )
                return false;
              if (packet.envelope.format === TOMBSTONE_FORMAT) {
                if (
                  object.envelope.format !== TOMBSTONE_FORMAT ||
                  object.value !== null
                )
                  return false;
              } else openDataDocument(changed.model, changed.area, object);
              return true;
            },
          );
          return confirmations.every((accepted) => accepted);
        };
      this.live();
      if (generation !== this.generation) throw new ProtectedWriteConflict();
      retained = true;
      return {
        value: result,
        groups: [...grouped.values()],
        guards: [...heads]
          .filter(([domain]) => !grouped.has(domain))
          .map(([domain, sequence]) => ({ domain, sequence })),
        versions: [...grouped.values()].flatMap((group) =>
          group.packets.map((packet) => ({
            domain: packet.domain,
            id: packet.envelope.object,
            revision: packet.envelope.revision,
            signature: packet.envelope.signature,
          })),
        ),
        close,
      };
    } finally {
      active = false;
      if (!retained) close();
    }
  }
  remove(
    request: DataRequest,
    id: string,
    options: { expectedRevision?: string; signal?: AbortSignal } = {},
  ): Promise<void> {
    const signal = options.signal
      ? AbortSignal.any([this.controller.signal, options.signal])
      : this.controller.signal;
    return this.transaction(
      [request],
      async (transaction) => {
        transaction.require(request, "delete");
        const document = transaction
          .documents(request)
          .find((document) => document.id === id);
        if (document) {
          if (
            options.expectedRevision !== undefined &&
            document.revision !== options.expectedRevision
          ) {
            throw new ProtectedWriteConflict();
          }
          transaction.delete(request, id);
          return;
        }
        // A retry may find the signed tombstone rather than an ordinary model.
        // Absence alone must not turn a failed deletion into a success.
        const opened = await this.storage.open(signal, [request.area.domain]);
        const collection = opened(request.area);
        try {
          const deleted = await collection.get(id);
          this.live();
          if (
            deleted.envelope.format !== TOMBSTONE_FORMAT ||
            deleted.value !== null
          ) {
            throw new InvalidProtectedData();
          }
          if (
            options.expectedRevision !== undefined &&
            BigInt(deleted.envelope.revision) !==
              BigInt(options.expectedRevision) + 1n
          ) {
            throw new ProtectedWriteConflict();
          }
        } finally {
          collection.close();
        }
      },
      { signal },
    );
  }
  /** Catalogue deletion also updates signed references and uses a separate
   * public proof. It cannot be substituted by an ordinary tombstone. */
  removeStock(request: DataRequest, id: string): Promise<void> {
    return this.operations.run(async () => {
      const reads = new Map<string, DataCollection>();
      try {
        await this.loadCurrent([request], reads);
        const resource = this.resources.get(dataAreaKey(request.area))!;
        const document = resource.documents.find(
          (document) => document.object.envelope.object === id,
        );
        const collection = reads.get(dataAreaKey(request.area))!;
        // The storage port must verify a signed deletion proof when retrying an
        // already removed object. Mere absence is not evidence of our deletion.
        await collection.remove(id, document?.object.envelope);
        const remaining = request.ids
          ? await collection.selected([id])
          : await collection.read();
        this.live();
        if (remaining.some((object) => object.envelope.object === id))
          throw new ProtectedWriteConflict();
      } finally {
        this.invalidate(new Set([request.area.domain]));
        for (const read of reads.values()) read.close();
      }
    });
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    const database = this.database;
    this.invalidate();
    this.resources.clear();
    this.projectedResources.clear();
    this.tables.clear();
    this.stale.clear();
    this.listeners.clear();
    await this.operations.drained();
    if (database) await (await database).close();
  }
}
