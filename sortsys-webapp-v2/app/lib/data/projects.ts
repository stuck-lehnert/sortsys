import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData, record } from "@sortsys/zerotrust";
import { trustedHistory } from "../crypto/session";
import { addressId, addressText, wireAddress, compareAddresses, CONTACT_COLLECTION, CONTACT_MODEL, CUSTOMER_COLLECTION, CUSTOMER_MODEL, partialAddressRecord, type createProtectedAddressBook } from "./addressBook";
import type { DuckDriver } from "./database";
import { required } from "./protectedObjects";
import { newProductRowId, publicId } from "./products";
import { PROJECT_MODEL, projectChanges, projectCollection, projectDomainId, projectMatches, projectPayload, wireProject, PROJECT_MUTATIONS, PROJECT_QUERIES, type ProjectPayload } from "./projectData";
import { readableProjectAreas } from "./projectAreas";
import { fileCollection } from "./projectFileData";
import { deliveryCollection } from "./deliveryNoteData";
import { createProjectArea } from "./createProjectArea";
import { decodeBusinessRow } from "./rowCodec";
import { businessSchema } from "./schema";
import { commitProtectedWrites } from "./atomicWrites";
import { addProjectOffer, emptyProjectCommercial, PROJECT_COMMERCIAL_FACETS, PROJECT_REGISTER_MODEL, projectCommercialCollection } from "./projectCommercial";
import { acquireDataRuntime } from "./runtime/session";
import type { DataRequest, DataView } from "./runtime/runtime";

type Directory = ReturnType<typeof createProtectedAddressBook>;
const request = (id: string) => ({ model: PROJECT_MODEL, area: projectCollection(id) });
const contactRequest = { model: CONTACT_MODEL, area: CONTACT_COLLECTION }, customerRequest = { model: CUSTOMER_MODEL, area: CUSTOMER_COLLECTION };
function document(view: DataView, selected: DataRequest<ProjectPayload>) {
  const documents = view.documents(selected);
  if (documents.length !== 1 || !documents[0]!.value.project) throw new InvalidProtectedData(); return documents[0]!;
}

export function createProtectedProjects(client: Client, signal: AbortSignal, directory: () => Promise<Directory>, driver?: () => Promise<DuckDriver>) {
  const lease = acquireDataRuntime(client, signal, driver), runtime = lease.runtime, live = lease.live;
  async function certifiedUser(id: string) { const history = await trustedHistory(client); live(); history.identityCertificate(`user:${id}`); }
  async function read(id: string, fresh = false) {
    live(); if (fresh) runtime.revalidate(); const selected = request(id);
    const result = await runtime.read([selected], view => ({ ...document(view, selected), head: view.head(selected) })); live(); return result;
  }
  async function prepareCreate(input: unknown, offer?: { caseId: string; amount: string; comment: string }) {
    live(); const changes = projectChanges(input, true), guards: { domain: string; sequence: string }[] = [];
    if (changes.customer_id != null) guards.push(await (await directory()).references("customers", [publicId(changes.customer_id)]));
    if (changes.responsible_project_leader_user_id != null) await certifiedUser(publicId(changes.responsible_project_leader_user_id));
    const session = await required(client.query("auth.sessionInfo", undefined, { strategy: "network-only" })); live();
    const id = publicId(newProductRowId()), now = new Date().toISOString(), actor = session.user.id;
    const project = decodeBusinessRow({ format: "sortsys-row-v2", schema: businessSchema.fingerprint, table: "projects", values: {
      id: addressId(id), created_at: now, modified_at: now, finished_at: null, ...changes, created_by_user_id: addressId(actor),
    } });
    const selected = request(id), value = projectPayload({ format: "sortsys-project-v1", project, contacts: [] }, selected.area.prefix, id);
    for (const area of [selected.area, fileCollection(id), deliveryCollection(id), ...PROJECT_COMMERCIAL_FACETS.map(facet => projectCommercialCollection(id, facet))]) {
      await createProjectArea(client, area, signal); live();
    }
    const registers = PROJECT_COMMERCIAL_FACETS.map(facet => ({ model: PROJECT_REGISTER_MODEL, area: projectCommercialCollection(id, facet) }));
    const prepared = await runtime.prepare([selected, ...registers], tx => {
      tx.create(selected, selected.area.prefix, value);
      for (const register of registers) {
        const facet = register.area.facet as typeof PROJECT_COMMERCIAL_FACETS[number], empty = emptyProjectCommercial(id, facet);
        const value = facet === "offer-prices" && offer ? { ...addProjectOffer(empty, { ...offer, actor, now }), mainCaseId: offer.caseId } : empty;
        tx.create(register, `${register.area.prefix}register`, value);
      }
      return id;
    }, guards);
    live(); return { id, groups: prepared.groups, guards: prepared.guards };
  }
  return {
    close: lease.close,
    prepareCreate,
    async getMany(ids: string[]) {
      live(); if (ids.length > 2000 || new Set(ids).size !== ids.length) throw new InvalidProtectedData();
      const selected = ids.map(request), values = await runtime.read(selected, view => selected.map(selected => wireProject(document(view, selected).value))); live(); return values;
    },
    async references(id: string) {
      const current = await read(id, true); return { project: wireProject(current.value), source: current.value.project!, head: current.head };
    },
    async refresh(domains?: Record<string, string | null>) {
      live(); if (!domains) { runtime.revalidate(); return; }
      runtime.invalidate(new Set(Object.keys(domains).filter(projectDomainId)), new Map(Object.entries(domains).filter((entry): entry is [string, string] => entry[1] !== null)));
    },
    async query(path: string, input: unknown): Promise<unknown> {
      live(); if (!PROJECT_QUERIES.has(path)) throw new InvalidProtectedData();
      if (path === "projects.get") { const data = record(input, ["id"]); return wireProject((await read(data.id as string)).value); }
      if (path === "projects.contacts.list") {
        const data = record(input, ["projectId"]), selected = request(data.projectId as string);
        const result = await runtime.read([selected, contactRequest], view => {
          const project = document(view, selected).value, labels = new Map(project.contacts.map(row => [publicId(row.values.contact_id), row.values.label as string | null]));
          return view.documents(contactRequest).filter(contact => contact.value.row && labels.has(publicId(contact.value.row.values.id))).map(document => {
            const contact = wireAddress(document.value); if ("name" in contact) throw new InvalidProtectedData(); return { ...contact, label: labels.get(contact.id)! };
          }).sort(compareAddresses);
        }); live(); return result;
      }
      const forContact = path === "contacts.projects.list", data = forContact ? record(input, ["contactId"]) : partialAddressRecord(input ?? {}, ["search", "finished", "customerId", "orderBy"]);
      if (forContact) addressId(data.contactId);
      else {
        if (data.finished != null && typeof data.finished !== "boolean" || data.orderBy != null && !["title", "activity"].includes(data.orderBy as string)) throw new InvalidProtectedData();
        if (data.customerId != null) addressId(data.customerId);
        if (data.search != null && typeof data.search !== "string") throw new InvalidProtectedData();
      }
      const areas = await readableProjectAreas(client, signal); live(); const selected = areas.map(area => ({ model: PROJECT_MODEL, area }));
      const values = await runtime.read(selected, view => selected.flatMap(selected => view.documents(selected)).map(document => document.value).filter(project => project.project)
        .filter(project => !forContact || project.contacts.some(link => publicId(link.values.contact_id) === data.contactId)).map(wireProject)
        .filter(project => forContact || (data.finished == null || !!project.finishedAt === data.finished) && (data.customerId == null || project.customerId === data.customerId) && projectMatches(project, data.search))
        .sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()) || a.id.localeCompare(b.id)));
      live(); if (data.orderBy === "activity") values.sort((a, b) => Math.max(b.modifiedAt.getTime(), b.createdAt.getTime()) - Math.max(a.modifiedAt.getTime(), a.createdAt.getTime())); return values;
    },
    async mutate(path: string, input: unknown): Promise<unknown> {
      live(); if (!PROJECT_MUTATIONS.has(path)) throw new InvalidProtectedData();
      if (path === "projects.create") {
        const prepared = await prepareCreate(input);
        try { await commitProtectedWrites(client, prepared.groups, signal, prepared.guards); live(); return { id: prepared.id }; }
        finally { for (const group of prepared.groups) group.close(); }
      }
      const linking = path.startsWith("projects.contacts."), now = new Date().toISOString();
      const data = linking ? partialAddressRecord(input, path.endsWith(".set") ? ["projectId", "contacts"] : ["projectId", "contactId", "label"]) : record(input, path === "projects.update" ? ["id", "data"] : ["id"]);
      const id = (linking ? data.projectId : data.id) as string, selected = request(id);
      if (linking) {
        const setting = path.endsWith(".set"), removing = path.endsWith(".remove"), entries = setting ? data.contacts : [{ contactId: data.contactId, label: data.label }];
        if (!Array.isArray(entries) || entries.length > 10000) throw new InvalidProtectedData();
        const links = entries.map(entry => { const link = partialAddressRecord(entry, ["contactId", "label"]); addressId(link.contactId); return { id: link.contactId as string, label: addressText(link.label, false, 127) }; });
        await runtime.transaction([selected, ...(!removing && links.length ? [contactRequest] : [])], tx => {
          const original = document(tx, selected).value, current = new Map(original.contacts.map(row => [publicId(row.values.contact_id), row])); if (setting) current.clear();
          const contacts = !removing && links.length ? new Set(tx.documents(contactRequest).filter(document => document.value.row).map(document => publicId(document.value.row!.values.id))) : null;
          for (const link of links) {
            if (removing) { if (!current.delete(link.id)) throw new InvalidProtectedData(); }
            else {
              if (!contacts!.has(link.id)) throw new InvalidProtectedData();
              current.set(link.id, decodeBusinessRow({ format: "sortsys-row-v2", schema: businessSchema.fingerprint, table: "project_contacts", values: { project_id: original.project!.values.id, contact_id: addressId(link.id), label: link.label } }));
            }
          }
          tx.edit(selected, selected.area.prefix, payload => { payload.contacts = [...current.values()]; });
        }); live(); return { success: true };
      }
      const finishing = path === "projects.finish" || path === "projects.resume", deleting = path === "projects.delete";
      const changes = finishing || deleting ? {} : projectChanges(data.data, false);
      const baseline = changes.customer_id != null || changes.responsible_project_leader_user_id != null ? await read(id) : null;
      const needsCustomer = changes.customer_id != null && changes.customer_id !== baseline?.value.project?.values.customer_id;
      if (changes.responsible_project_leader_user_id != null && changes.responsible_project_leader_user_id !== baseline?.value.project?.values.responsible_project_leader_user_id) await certifiedUser(publicId(changes.responsible_project_leader_user_id));
      await runtime.transaction([selected, ...(needsCustomer ? [customerRequest] : [])], tx => {
        const original = document(tx, selected).value;
        if (baseline) tx.expect(selected, selected.area.prefix, { signature: baseline.signature });
        if (deleting) { tx.require(selected, "delete"); tx.edit(selected, selected.area.prefix, payload => { payload.project = null; payload.contacts = []; }); return; }
        if (finishing) {
          tx.require(selected, "update"); const finish = path === "projects.finish";
          if (!!original.project!.values.finished_at === finish) return; changes.finished_at = finish ? now : null;
        }
        if (needsCustomer && !tx.documents(customerRequest).some(document => document.value.row?.values.id === changes.customer_id)) throw new InvalidProtectedData();
        tx.patch("projects", { id: addressId(id) }, { ...changes, modified_at: now });
      }); live(); return { success: true };
    },
  };
}
