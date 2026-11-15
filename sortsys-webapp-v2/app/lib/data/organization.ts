import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { isWriteConflict, ProtectedWriteConflict } from "./atomicWrites";
import { uiText } from "../i18n";
import { organizationRequest as request } from "./organizationModel";
import { acquireDataRuntime } from "./runtime/session";
import type { DuckDriver } from "./database";
import { required } from "./protectedObjects";
import {
  ORGANIZATION_QUERIES,
  ORGANIZATION_MUTATIONS,
  organizationArea,
  organizationObject,
  organizationProfile,
  organizationNumbering,
  type OrganizationKind,
  type OrganizationEdit,
  type OrganizationValues,
} from "./organizationData";

export class OrganizationEditConflict extends ProtectedWriteConflict {
  constructor() {
    super();
    this.name = "OrganizationEditConflict";
    this.message = uiText(
      "Die Einstellungen wurden inzwischen geändert. Das Formular muss vor dem erneuten Speichern neu geladen werden.",
      "The settings have changed. Reload the form before saving again.",
    );
  }
}

export function createProtectedOrganization(
  client: Client,
  signal: AbortSignal,
  driver?: () => Promise<DuckDriver>,
) {
  const lease = acquireDataRuntime(client, signal, driver);
  const runtime = lease.runtime;
  async function admin() {
    lease.live();
    const session = await required(
      client.query("auth.sessionInfo", undefined, { strategy: "network-only" }),
    );
    lease.live();
    if (!session.roles.includes(":admin")) throw new InvalidProtectedData();
  }
  const kind = (path: string): OrganizationKind =>
    path.startsWith("settings.organization.") ? "profile" : "numbering";
  async function load(selected: OrganizationKind, fresh = false) {
    lease.live();
    if (fresh) runtime.revalidate();
    const selectedRequest = request(selected);
    const value = await runtime.read([selectedRequest], (view) => {
      const documents = view.documents(selectedRequest);
      if (documents.length !== 1 || !documents[0]!.signature)
        throw new InvalidProtectedData();
      return documents[0]!;
    });
    lease.live();
    return value;
  }
  async function write(
    selected: OrganizationKind,
    input: unknown,
    expected?: string,
  ): Promise<string> {
    await admin();
    const selectedRequest = request(selected);
    const id = organizationObject(selected);
    const value =
      selected === "profile"
        ? organizationProfile(input, true)
        : organizationNumbering(input);
    let signature: string | undefined;
    try {
      await runtime.transaction(
        [selectedRequest],
        (tx) => {
          if (tx.documents(selectedRequest).length !== 1)
            throw new InvalidProtectedData();
          if (expected !== undefined)
            tx.expect(selectedRequest, id, { signature: expected });
          tx.edit(selectedRequest, id, (payload) => {
            payload.value = value;
          });
        },
        {
          verified: (versions) => {
            signature = versions.find(
              (version) =>
                version.domain === selectedRequest.area.domain &&
                version.id === id,
            )?.signature;
          },
        },
      );
      lease.live();
      if (!signature) throw new InvalidProtectedData();
      return signature;
    } catch (error) {
      if (expected !== undefined && isWriteConflict(error))
        throw new OrganizationEditConflict();
      throw error;
    }
  }
  return {
    async query(path: string, input: unknown) {
      lease.live();
      if (
        !ORGANIZATION_QUERIES.has(path) ||
        (input !== undefined && input !== null)
      )
        throw new InvalidProtectedData();
      const selected = kind(path);
      if (selected === "numbering") await admin();
      return (await load(selected)).value.value;
    },
    async mutate(path: string, input: unknown) {
      lease.live();
      if (!ORGANIZATION_MUTATIONS.has(path)) throw new InvalidProtectedData();
      await write(kind(path), input);
      return { success: true };
    },
    async edit<K extends OrganizationKind>(
      selected: K,
    ): Promise<OrganizationEdit<K>> {
      if (selected !== "profile" && selected !== "numbering")
        throw new InvalidProtectedData();
      await admin();
      const document = await load(selected, true);
      let basis = document.signature!;
      return {
        value: document.value.value as OrganizationValues[K],
        async save(value: OrganizationValues[K]) {
          // A form advances only to its own verified write, never another view's
          // newer cache entry. Concurrent saves retain the same original basis.
          basis = await write(selected, value, basis);
        },
      };
    },
    async refresh(domains?: Record<string, string | null>) {
      lease.live();
      runtime.invalidate(
        new Set(
          (["profile", "numbering"] as const)
            .map((kind) => organizationArea(kind).domain)
            .filter((domain) => !domains || Object.hasOwn(domains, domain)),
        ),
      );
    },
    close: lease.close,
  };
}
