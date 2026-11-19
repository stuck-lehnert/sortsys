import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";
import { trustedHistory } from "../crypto/session";
import {
  addressId,
  addressText,
  CONTACT_COLLECTION,
  CONTACT_MODEL,
  CUSTOMER_COLLECTION,
  CUSTOMER_MODEL,
  partialAddressRecord,
} from "./addressBook";
import type { PlanningTitleChange } from "./planningTitlePublication";
import {
  projectChanges,
  projectDocument,
  projectRequest,
  type ProjectEditPath,
} from "./projectData";
import { publicId } from "./products";
import { decodeBusinessRow } from "./rowCodec";
import { businessSchema } from "./schema";
import type { DataCommand, DataRuntime } from "./runtime/runtime";

export const projectContactRequest = {
  model: CONTACT_MODEL,
  area: CONTACT_COLLECTION,
};
const customerRequest = { model: CUSTOMER_MODEL, area: CUSTOMER_COLLECTION };

type Result = { success: true; planningTitle?: PlanningTitleChange };
type ProjectCommand = DataCommand<Result> & { mayRename?: boolean };

export async function certifyProjectLeader(client: Client, id: string) {
  const history = await trustedHistory(client);
  history.identityCertificate(`user:${id}`);
}

function contactCommand(path: ProjectEditPath, input: unknown): ProjectCommand {
  const setting = path === "projects.contacts.set";
  const removing = path === "projects.contacts.remove";
  const data = partialAddressRecord(
    input,
    setting ? ["projectId", "contacts"] : ["projectId", "contactId", "label"],
  );
  const selected = projectRequest(publicId(addressId(data.projectId)));
  const entries = setting
    ? data.contacts
    : [{ contactId: data.contactId, label: data.label }];
  if (!Array.isArray(entries) || entries.length > 10_000) {
    throw new InvalidProtectedData();
  }
  const links = entries.map((entry) => {
    const link = partialAddressRecord(entry, ["contactId", "label"]);
    return {
      id: addressId(link.contactId),
      label: addressText(link.label, false, 127),
    };
  });
  const checkContacts = !removing && links.length > 0;

  return {
    requests: checkContacts ? [selected, projectContactRequest] : [selected],
    apply(tx) {
      tx.require(selected, "update");
      const original = projectDocument(tx, selected).value;
      const current = new Map(
        original.contacts.map((row) => [row.values.contact_id, row]),
      );
      if (setting) current.clear();

      for (const link of links) {
        if (removing) {
          if (!current.delete(link.id)) throw new InvalidProtectedData();
          continue;
        }
        tx.row("contacts", { id: link.id });
        current.set(
          link.id,
          decodeBusinessRow({
            format: "sortsys-row-v2",
            schema: businessSchema.fingerprint,
            table: "project_contacts",
            values: {
              project_id: original.project!.values.id,
              contact_id: link.id,
              label: link.label,
            },
          }),
        );
      }
      tx.edit(selected, selected.area.prefix, (payload) => {
        payload.contacts = [...current.values()];
      });
      return { success: true };
    },
  };
}

export async function projectEditCommand(
  client: Client,
  runtime: DataRuntime,
  path: ProjectEditPath,
  input: unknown,
): Promise<ProjectCommand> {
  if (path.startsWith("projects.contacts.")) return contactCommand(path, input);

  const updating = path === "projects.update";
  const data = record(input, updating ? ["id", "data"] : ["id"]);
  const id = addressId(data.id);
  const projectId = publicId(id);
  const selected = projectRequest(projectId);
  const changes = updating ? projectChanges(data.data, false) : {};
  const customerId = changes.customer_id;
  const leaderId = changes.responsible_project_leader_user_id;

  // Forms can repeat an unchanged reference without opening another facet.
  // Bind that exception to the exact project read during preparation.
  const baseline =
    customerId != null || leaderId != null
      ? await runtime.read([selected], (view) => projectDocument(view, selected))
      : null;
  const previous = baseline?.value.project?.values;
  const checkCustomer = customerId != null && customerId !== previous?.customer_id;
  if (leaderId != null && leaderId !== previous?.responsible_project_leader_user_id)
    await certifyProjectLeader(client, publicId(leaderId));

  const title = changes.title;
  const now = new Date().toISOString();
  return {
    mayRename: typeof title === "string",
    requests: checkCustomer ? [selected, customerRequest] : [selected],
    apply(tx) {
      tx.require(selected, "update");
      const original = projectDocument(tx, selected).value.project!;
      if (baseline) {
        tx.expect(selected, selected.area.prefix, { signature: baseline.signature });
      }
      if (customerId != null && customerId !== original.values.customer_id) {
        tx.require(customerRequest, "read");
        tx.row("customers", { id: customerId });
      }

      const fields: Record<string, unknown> = { ...changes, modified_at: now };
      if (!updating) {
        const finish = path === "projects.finish";
        if (!!original.values.finished_at === finish) return { success: true };
        fields.finished_at = finish ? now : null;
      }
      tx.patch("projects", { id }, fields);

      if (typeof title === "string" && title !== original.values.title) {
        return { success: true, planningTitle: { projectId, title } };
      }
      return { success: true };
    },
  };
}
