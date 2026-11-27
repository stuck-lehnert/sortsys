import type { Client } from "@sortsys/v2-client";
import {
  InvalidProtectedData,
  record,
  TOMBSTONE_FORMAT,
} from "@sortsys/zerotrust/sortsys";
import { buildPrefixSearch } from "../search/prefixQuery";
import {
  addressId,
  CONTACT_COLLECTION,
  partialAddressRecord,
  readLinkedContacts,
  type createProtectedAddressBook,
} from "./addressBook";
import type { DuckDriver } from "./database";
import { protectedCollection, required } from "./protectedObjects";
import { newProductRowId, publicId } from "./products";
import {
  PROJECT_MODEL,
  isProjectEdit,
  projectCreationInput,
  projectDocument as document,
  projectRequest as request,
  projectCollection,
  projectDomainId,
  projectPayload,
  projectSearchFields,
  wireProject,
  PROJECT_MUTATIONS,
  PROJECT_QUERIES,
  type ProjectPayload,
} from "./projectData";
import { readableProjectAreas } from "./projectAreas";
import { PROJECT_ACCESS_KEYS, projectAccessArea } from "./projectScope";
import { createResourceAreas } from "./createProjectArea";
import { createBusinessRow } from "./rowCodec";
import { commitProtectedWrites } from "./atomicWrites";
import {
  addProjectOffer,
  emptyProjectCommercial,
  PROJECT_COMMERCIAL_FACETS,
  PROJECT_REGISTER_MODEL,
  projectCommercialCollection,
} from "./projectCommercial";
import { acquireDataRuntime } from "./runtime/session";
import { announceDataChanges } from "./runtime/changes";
import { attachPlanningTitles } from "./planningTitlePublication";
import { timestampMicros } from "./timestamps";
import {
  certifyProjectLeader,
  projectContactLinks,
  projectContactRequest as contactRequest,
  projectContactRow,
  projectEditCommand,
} from "./projectWrites";

type Directory = ReturnType<typeof createProtectedAddressBook>;
/** The signed master tombstone closes all of the project's areas. Reading
 * loaded dependents is unnecessary and would require unrelated grants. */
export async function deleteProtectedProject(
  client: Client,
  input: unknown,
  signal: AbortSignal,
) {
  const { id } = record(input, ["id"]);
  addressId(id);
  const project = id as string;
  const area = projectCollection(project);
  const collection = await protectedCollection(client, area, signal);
  try {
    await collection.inspect();
    const original = await collection.get(area.prefix);
    if (!projectPayload(original.value, area.prefix, project).project)
      throw new InvalidProtectedData();
    const packet = await collection.tombstone(area.prefix, original.envelope);
    await commitProtectedWrites(
      client,
      [{
        head: { domain: area.domain, sequence: collection.snapshot() },
        packets: [packet],
        async verify() {
          const saved = await collection.get(area.prefix);
          return saved.value === null &&
            saved.envelope.format === TOMBSTONE_FORMAT &&
            saved.envelope.signature === packet.envelope.signature;
        },
        close: collection.close,
      }],
      signal,
    );
    const dependents = PROJECT_ACCESS_KEYS
      .filter((key) => key !== "master-data")
      .map((key) => projectAccessArea(project, key).domain);
    announceDataChanges(client, new Set(dependents), { control: true });
    return { success: true as const };
  } finally {
    collection.close();
  }
}

const projectSearch = Symbol("project search");
const projectChangeSearch = Symbol("project change search");
type Project = ReturnType<typeof wireProject>;

function compareProjects(a: Project, b: Project) {
  return a.title.toLowerCase().localeCompare(b.title.toLowerCase()) ||
    a.id.localeCompare(b.id);
}

function projectChangeTime(payload: ProjectPayload) {
  if (!payload.project) throw new InvalidProtectedData();

  const { created_at, modified_at } = payload.project.values;
  const created = timestampMicros(created_at as string);
  const modified = timestampMicros(modified_at as string);
  return modified > created ? modified : created;
}

function projectsByChangeTime(payloads: ProjectPayload[]) {
  return payloads
    .map((payload) => ({
      project: wireProject(payload),
      changedAt: projectChangeTime(payload),
    }))
    .sort((a, b) => {
      if (a.changedAt !== b.changedAt) return a.changedAt > b.changedAt ? -1 : 1;
      return compareProjects(a.project, b.project);
    })
    .map(({ project }) => project);
}

export function createProtectedProjects(
  client: Client,
  signal: AbortSignal,
  directory: () => Promise<Directory>,
  driver?: () => Promise<DuckDriver>,
) {
  const lease = acquireDataRuntime(client, signal, driver),
    runtime = lease.runtime,
    live = lease.live;
  async function read(id: string, fresh = false) {
    live();
    if (fresh) runtime.revalidate();

    const selected = request(id);
    const result = await runtime.read(
      [selected],
      (view) => ({
        ...document(view, selected),
        head: view.head(selected),
      }),
      undefined,
      { batchDirectory: !fresh },
    );

    live();
    return result;
  }
  async function prepareCreate(
    input: unknown,
    offer?: { caseId: string; amount: string; comment: string },
  ) {
    live();
    const { changes, contacts } = projectCreationInput(input);
    const links = projectContactLinks(contacts === undefined ? [] : contacts);
    const customer = changes.customer_id;
    const leader = changes.responsible_project_leader_user_id;

    async function directoryGuards() {
      if (customer == null && !links.size) return [];

      const book = await directory();
      const guards = [];
      if (customer != null) {
        guards.push(await book.references("customers", [publicId(customer)]));
      }
      if (links.size) {
        const ids = [...links.keys()].map(publicId);
        guards.push(await book.references("contacts", ids));
      }

      return guards;
    }

    // Check references before provisioning; publication also guards their heads.
    const [session, guards] = await Promise.all([
      required(
        client.query("auth.sessionInfo", undefined, { strategy: "network-only" }),
      ),
      directoryGuards(),
      leader == null ? undefined : certifyProjectLeader(client, publicId(leader)),
    ]);
    live();

    const id = publicId(newProductRowId()),
      now = new Date().toISOString(),
      actor = session.user.id;
    const projectId = addressId(id);
    const project = createBusinessRow("projects", {
      id: projectId,
      created_at: now,
      modified_at: now,
      finished_at: null,
      ...changes,
      created_by_user_id: addressId(actor),
    });
    const selected = request(id),
      value = projectPayload(
        {
          format: "sortsys-project-v1",
          project,
          contacts: [...links].map(([id, label]) =>
            projectContactRow(projectId, id, label),
          ),
        },
        selected.area.prefix,
        id,
      );
    await createResourceAreas(
      client,
      PROJECT_ACCESS_KEYS.map((key) => projectAccessArea(id, key)),
      "project",
      signal,
    );
    live();
    const registers = PROJECT_COMMERCIAL_FACETS.map((facet) => ({
      model: PROJECT_REGISTER_MODEL,
      area: projectCommercialCollection(id, facet),
    }));
    const prepared = await runtime.prepare(
      [selected, ...registers],
      (tx) => {
        tx.create(selected, selected.area.prefix, value);
        for (const register of registers) {
          const facet = register.area
              .facet as (typeof PROJECT_COMMERCIAL_FACETS)[number],
            empty = emptyProjectCommercial(id, facet);
          const value =
            facet === "offer-prices" && offer
              ? {
                  ...addProjectOffer(empty, { ...offer, actor, now }),
                  mainCaseId: offer.caseId,
                }
              : empty;
          tx.create(register, `${register.area.prefix}register`, value);
        }
        return id;
      },
      guards,
    );
    live();
    return { id, groups: prepared.groups, guards: prepared.guards };
  }
  return {
    close: lease.close,
    prepareCreate,
    async getMany(ids: string[]) {
      live();
      if (ids.length > 2000 || new Set(ids).size !== ids.length)
        throw new InvalidProtectedData();

      const selected = ids.map(request);
      const values = await runtime.read(
        selected,
        (view) =>
          selected.map((item) => wireProject(document(view, item).value)),
        undefined,
        { batchDirectory: true },
      );

      live();
      return values;
    },
    async references(id: string) {
      const current = await read(id, true);
      return {
        project: wireProject(current.value),
        source: current.value.project!,
        head: current.head,
      };
    },
    async refresh(domains?: Record<string, string | null>) {
      live();
      if (!domains) {
        runtime.revalidate();
        return;
      }
      runtime.invalidate(
        new Set(Object.keys(domains).filter(projectDomainId)),
        new Map(
          Object.entries(domains).filter(
            (entry): entry is [string, string] => entry[1] !== null,
          ),
        ),
      );
    },
    async query(path: string, input: unknown, limit?: number): Promise<unknown> {
      live();
      if (!PROJECT_QUERIES.has(path)) throw new InvalidProtectedData();
      if (path === "projects.get") {
        const data = record(input, ["id"]);
        return wireProject((await read(data.id as string)).value);
      }
      if (path === "projects.contacts.list") {
        const { projectId } = record(input, ["projectId"]);
        const id = projectId as string;
        const selected = request(id);
        const current = await read(id);
        const labels = new Map(
          current.value.contacts.map((row) => [
            publicId(row.values.contact_id),
            row.values.label as string | null,
          ]),
        );
        const contacts = await readLinkedContacts(
          runtime,
          selected,
          current.head.sequence,
          [...labels.keys()],
        );
        live();
        return contacts.map((contact) => ({
          ...contact,
          label: labels.get(contact.id)!,
        }));
      }
      const forContact = path === "contacts.projects.list",
        data = forContact
          ? record(input, ["contactId"])
          : partialAddressRecord(input ?? {}, [
              "search",
              "finished",
              "customerId",
              "orderBy",
            ]);
      if (forContact) addressId(data.contactId);
      else {
        if (
          (data.finished != null && typeof data.finished !== "boolean") ||
          (data.orderBy != null &&
            !["title", "activity"].includes(data.orderBy as string))
        )
          throw new InvalidProtectedData();
        if (data.customerId != null) addressId(data.customerId);
        if (data.search != null && typeof data.search !== "string")
          throw new InvalidProtectedData();
      }
      const areas = await readableProjectAreas(client, signal);
      live();
      const selected = areas.map((area) => ({ model: PROJECT_MODEL, area }));
      const linkedContact = forContact
        ? { ...contactRequest, ids: [CONTACT_COLLECTION.prefix + data.contactId] }
        : null;
      const byActivity = data.orderBy === "activity";
      const values = await runtime.read(
        linkedContact ? [...selected, linkedContact] : selected,
        (view) => {
          const projects = () =>
            selected
              .flatMap((request) => view.documents(request))
              .map((document) => document.value)
              .filter((project) => project.project);
          if (linkedContact) {
            if (!view.documents(linkedContact)[0]?.value.row)
              throw new InvalidProtectedData();
            return projects()
              .filter((project) =>
                project.contacts.some(
                  (link) => publicId(link.values.contact_id) === data.contactId,
                ),
              )
              .map(wireProject)
              .sort(compareProjects);
          }
          const search = view.derive(
            byActivity ? projectChangeSearch : projectSearch,
            selected,
            () => {
              const payloads = projects();
              const ordered = byActivity
                ? projectsByChangeTime(payloads)
                : payloads.map(wireProject).sort(compareProjects);
              return buildPrefixSearch(ordered, projectSearchFields);
            },
          );
          return search(
            data.search as string | undefined,
            (project) =>
              (data.finished == null || !!project.finishedAt === data.finished) &&
              (data.customerId == null || project.customerId === data.customerId),
            limit,
          );
        },
        undefined,
        { batchDirectory: !linkedContact || limit !== undefined },
      );
      live();
      return values;
    },
    async mutate(path: string, input: unknown): Promise<unknown> {
      live();
      if (!PROJECT_MUTATIONS.has(path)) throw new InvalidProtectedData();
      if (path === "projects.create") {
        const prepared = await prepareCreate(input);
        try {
          if (prepared.groups.length) {
            await commitProtectedWrites(
              client,
              prepared.groups,
              signal,
              prepared.guards,
            );
          }
          live();
          return { id: prepared.id };
        } finally {
          for (const group of prepared.groups) group.close();
        }
      }
      if (path === "projects.delete")
        return deleteProtectedProject(client, input, signal);
      if (!isProjectEdit(path)) throw new InvalidProtectedData();
      const command = await projectEditCommand(client, runtime, path, input);
      live();
      if (command.mayRename) {
        const prepared = await runtime.prepare(command.requests, command.apply);
        try {
          if (prepared.value.planningTitle) {
            await attachPlanningTitles(
              client,
              prepared.groups,
              [prepared.value.planningTitle],
              signal,
            );
          }
          await commitProtectedWrites(
            client,
            prepared.groups,
            signal,
            prepared.guards,
          );
        } finally {
          prepared.close();
        }
      } else {
        await runtime.transaction(command.requests, command.apply);
      }
      live();
      return { success: true };
    },
  };
}
