import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { addressId, addressText, partialAddressRecord } from "./addressBook";
import { newProductRowId, prefixMatches, publicId } from "./products";
import type { DuckDriver } from "./database";
import { readableAreas } from "./readableAreas";
import { acquireDataRuntime } from "./runtime/session";
import {
  PERSONNEL_MODEL,
  PERSONNEL_QUERIES,
  PERSONNEL_MUTATIONS,
  personnelDomain,
  personnelCollection,
  personnelRequest,
  personnelChanges,
  personnelColumns,
  newPersonnelProfile,
  wirePersonnel,
} from "./personnelData";
import { provisionOwnedCollections } from "./prepareCollections";
import { required } from "./protectedObjects";
import { personnelPart, PERSONNEL_FACETS } from "./personnelData";
import {
  createMemberAccount,
  memberCreationFrame,
  memberLifecycle,
  type MemberAction,
  type MemberStatus,
} from "../crypto/members";
import { commitProtectedWrites, ProtectedWriteConflict } from "./atomicWrites";
import type { DataRequest, DataView } from "./runtime/runtime";
import type { PersonnelPart } from "./personnelData";
import {
  finishAccessChanges,
  shareNewPersonnelName,
} from "../crypto/permissions";
import { unlockedAccount } from "../crypto/session";
import { timestampMicros } from "./timestamps";
import { absenceCollection } from "./absenceData";

export function createProtectedPersonnel(
  client: Client,
  signal: AbortSignal,
  driver?: () => Promise<DuckDriver>,
) {
  const lease = acquireDataRuntime(client, signal, driver),
    { runtime, live } = lease;
  function requireMemberStatus(
    tx: import("./runtime/runtime").DataTransaction,
    id: string,
    status: MemberStatus,
  ) {
    const row = tx.row("users", { id: addressId(id) });
    if (row.require("username") !== status.username)
      throw new ProtectedWriteConflict();
    for (const [column, native] of [
      ["deactivated_at", status.deactivatedAt],
      ["archived_at", status.archivedAt],
    ] as const) {
      const value = row.require(column);
      if (value === null) {
        if (native !== null) throw new ProtectedWriteConflict();
      } else if (
        typeof value !== "string" ||
        native === null ||
        timestampMicros(value) !== timestampMicros(native)
      ) {
        throw new ProtectedWriteConflict();
      }
    }
  }
  let preparingSelf: Promise<void> | null = null;
  const drafts = new Map<string, string>();
  async function prepareSelf() {
    const session = await required(
      client.query("auth.sessionInfo", undefined, { strategy: "network-only" }),
    );
    live();
    if (!session.roles.includes(":admin")) return;
    const id = session.user.id,
      selected = PERSONNEL_FACETS.map((facet) => personnelRequest(id, facet));
    const domains = await required(
      client.query("zerotrust.domains.list", undefined, {
        strategy: "network-only",
      }),
    );
    live();
    const existing = domains.some(
      (domain) => domain.id === selected[0]!.area.domain,
    );
    if (!existing)
      await provisionOwnedCollections(
        client,
        `user:${id}`,
        selected.map((request) => request.area),
        signal,
      );
    else {
      const readable = await readableAreas(client, signal, (domain) =>
        domain === selected[0]!.area.domain ? selected[0]!.area : null,
      );
      live();
      if (!readable.length) return; // An existing denial is never repaired by bootstrap.
    }
    const present = await runtime.read(
      [selected[0]!],
      (view) => view.documents(selected[0]!).length > 0,
    );
    live();
    if (present) return;
    await provisionOwnedCollections(
      client,
      `user:${id}`,
      [
        ...selected.map((request) => request.area),
        absenceCollection(id),
        absenceCollection(id, true),
      ],
      signal,
    );
    live();
    const row = newPersonnelProfile(
      id,
      session.user.username,
      session.session.createdAt.toISOString(),
      null,
      session.user.locale,
    );
    await runtime.transaction(selected, (tx) => {
      live();
      if (tx.documents(selected[0]!).length) return;
      if (selected.slice(1).some((request) => tx.documents(request).length))
        throw new InvalidProtectedData();
      for (const request of selected)
        tx.create(
          request,
          request.area.prefix,
          personnelPart(row, personnelDomain(request.area.domain)!.facet),
        );
    });
    live();
    await (
      await import("../crypto/absenceDefaults")
    ).synchronizeAbsenceDefaults(client, signal, driver);
    live();
  }
  async function requests() {
    preparingSelf ??= prepareSelf().catch((error) => {
      preparingSelf = null;
      throw error;
    });
    await preparingSelf;
    live();
    const areas = await readableAreas(client, signal, (domain) => {
      const part = personnelDomain(domain);
      return part ? personnelCollection(part.id, part.facet) : null;
    });
    live();
    return areas.map((area) => ({ model: PERSONNEL_MODEL, area }));
  }
  async function supervisorPlan(
    id: string,
    supervisor: unknown,
    available: DataRequest<PersonnelPart>[],
  ) {
    const selected: DataRequest<PersonnelPart>[] = [],
      chainIds = new Set<string>();
    if (supervisor == null) return { selected, chainIds };
    const target = available.find(
      (request) =>
        request.area.facet === "master-data" &&
        addressId(personnelDomain(request.area.domain)!.id) === supervisor,
    );
    if (!target) throw new InvalidProtectedData();
    selected.push(target);
    const seen = new Set([addressId(id)]);
    let current: unknown = supervisor;
    while (current !== null) {
      if (typeof current !== "string" || seen.has(current) || seen.size > 120)
        throw new InvalidProtectedData();
      seen.add(current);
      const link = personnelRequest(publicId(current), "scope");
      if (
        !available.some((request) => request.area.domain === link.area.domain)
      )
        throw new InvalidProtectedData();
      runtime.revalidate(new Set([link.area.domain]));
      const next = await runtime.read([link], (view) =>
        view.row("users", { id: current }).require("supervisor_user_id"),
      );
      live();
      selected.push(link);
      chainIds.add(current);
      current = next;
    }
    return { selected, chainIds };
  }
  function checkSupervisor(
    view: DataView,
    id: string,
    supervisor: unknown,
    chainIds: Set<string>,
  ) {
    if (supervisor == null) return;
    const target = wirePersonnel(view, publicId(supervisor));
    if (target.archivedAt || target.deactivatedAt)
      throw new InvalidProtectedData();
    const seen = new Set([addressId(id)]);
    let current: unknown = supervisor;
    while (current !== null) {
      if (
        typeof current !== "string" ||
        seen.has(current) ||
        !chainIds.has(current)
      )
        throw new InvalidProtectedData();
      seen.add(current);
      current = view
        .row("users", { id: current })
        .require("supervisor_user_id");
    }
  }
  return {
    close: lease.close,
    async refresh() {
      live();
      runtime.revalidate();
    },
    async reference(id: string) {
      live();
      const request = personnelRequest(id, "master-data");
      const result = await runtime.read([request], (view) => {
        const user = wirePersonnel(view, id);
        if (user.archivedAt || user.deactivatedAt)
          throw new InvalidProtectedData();
        return { user, head: view.head(request) };
      });
      live();
      return result;
    },
    async query(path: string, input: unknown) {
      live();
      if (!PERSONNEL_QUERIES.has(path)) throw new InvalidProtectedData();
      const data = partialAddressRecord(
        input ?? {},
        path === "users.get"
          ? ["id"]
          : ["search", "deactivated", "includeArchived"],
      );
      if (path === "users.get") addressId(data.id);
      if (
        (data.deactivated != null && typeof data.deactivated !== "boolean") ||
        (data.includeArchived != null &&
          typeof data.includeArchived !== "boolean")
      )
        throw new InvalidProtectedData();
      const search = addressText(data.search, false, 1000),
        selected = (await requests()).filter(
          (request) =>
            path !== "users.get" ||
            personnelDomain(request.area.domain)!.id === data.id,
        );
      const result = await runtime.read(selected, (view) => {
        const users = selected
          .filter((request) => request.area.facet === "master-data")
          .flatMap((request) => {
            const id = personnelDomain(request.area.domain)!.id,
              related = selected.filter(
                (part) => personnelDomain(part.area.domain)!.id === id,
              );
            if (!view.documents(request).length) {
              if (related.some((part) => view.documents(part).length))
                throw new InvalidProtectedData();
              return []; // Reserved, unpublished profiles do not form directory entries.
            }
            if (related.some((part) => view.documents(part).length !== 1))
              throw new InvalidProtectedData();
            return [wirePersonnel(view, id)];
          });
        if (path === "users.get") {
          const user = users.find((user) => user.id === data.id);
          if (!user) throw new InvalidProtectedData();
          return user;
        }
        return users
          .filter(
            (user) =>
              (data.includeArchived || !user.archivedAt) &&
              (data.deactivated == null ||
                !!user.deactivatedAt === data.deactivated) &&
              prefixMatches(
                [
                  user.firstName,
                  user.lastName,
                  user.username,
                  user.email,
                  user.phone,
                  user.contractType,
                ],
                search,
              ),
          )
          .sort((a, b) =>
            a.lastName === null
              ? b.lastName === null
                ? a.firstName
                    .toLocaleLowerCase()
                    .localeCompare(b.firstName.toLocaleLowerCase())
                : 1
              : b.lastName === null
                ? -1
                : a.lastName
                    .toLocaleLowerCase()
                    .localeCompare(b.lastName.toLocaleLowerCase()) ||
                  a.firstName
                    .toLocaleLowerCase()
                    .localeCompare(b.firstName.toLocaleLowerCase()),
          );
      });
      live();
      return result;
    },
    async mutate(path: string, input: unknown) {
      live();
      if (!PERSONNEL_MUTATIONS.has(path)) throw new InvalidProtectedData();
      if (
        [
          "users.activate",
          "users.deactivate",
          "users.archive",
          "users.unarchive",
        ].includes(path)
      ) {
        const data = partialAddressRecord(input, ["id"]),
          id = data.id as string;
        addressId(id);
        const action = path.slice(6) as MemberAction,
          control = await memberLifecycle(client, id, action, signal);
        live();
        const request = personnelRequest(id, "master-data");
        const prepared = await runtime.prepare([request], (tx) => {
          live();
          tx.require(request, "update");
          requireMemberStatus(tx, id, control.status);
          if (!control.unchanged)
            tx.patch(
              "users",
              { id: addressId(id) },
              { ...control.values, modified_at: control.status.at },
            );
        });
        try {
          if (prepared.groups.length) {
            const packets = prepared.groups.flatMap((group) => group.packets);
            if (packets.length !== 1) throw new InvalidProtectedData();
            const member = await control.publication(packets[0]!);
            live();
            await commitProtectedWrites(
              client,
              prepared.groups,
              signal,
              prepared.guards,
              { member },
            );
            live();
          }
        } finally {
          prepared.close();
        }
        if (action === "activate" || action === "deactivate") {
          await finishAccessChanges(client, signal);
          live();
        }
        if (action === "activate") {
          await shareNewPersonnelName(client, id, signal);
          live();
        }
        return { success: true as const };
      }
      if (path === "users.create") {
        const data = partialAddressRecord(input, [
          "operationId",
          "username",
          "firstName",
          "lastName",
          "email",
          "phone",
          "contractType",
          "costPerHour",
          "vacationDaysPerYear",
          "supervisorUserId",
        ]);
        const { operationId, ...fields } = data,
          changes = personnelChanges(fields);
        if (
          typeof changes.username !== "string" ||
          typeof changes.first_name !== "string" ||
          !changes.first_name.trim()
        )
          throw new InvalidProtectedData();
        const username = changes.username;
        const id =
          operationId === undefined
            ? (drafts.get(username) ?? publicId(newProductRowId()))
            : (operationId as string);
        addressId(id);
        memberCreationFrame({
          tenant: "validation",
          generation: "1",
          author: "user:1",
          id,
          username,
        });
        drafts.set(username, id);
        const plan = await supervisorPlan(
          id,
          changes.supervisor_user_id,
          await requests(),
        );
        const created = await createMemberAccount(client, id, username, signal);
        live();
        const selected = PERSONNEL_FACETS.map((facet) =>
          personnelRequest(id, facet),
        );
        const row = newPersonnelProfile(
          id,
          username,
          created.createdAt.toISOString(),
          created.creator,
          created.locale,
          changes,
        );
        await provisionOwnedCollections(
          client,
          `user:${created.creator}`,
          [
            ...selected.map((request) => request.area),
            absenceCollection(id),
            absenceCollection(id, true),
          ],
          signal,
        );
        live();
        await runtime.transaction([...selected, ...plan.selected], (tx) => {
          live();
          checkSupervisor(tx, id, changes.supervisor_user_id, plan.chainIds);
          const existing = selected.map((request) => tx.documents(request));
          if (existing.some((objects) => objects.length)) {
            if (
              existing.some(
                (objects, index) =>
                  objects.length !== 1 ||
                  JSON.stringify(objects[0]!.value) !==
                    JSON.stringify(
                      personnelPart(row, PERSONNEL_FACETS[index]!),
                    ),
              )
            )
              throw new ProtectedWriteConflict();
            return;
          }
          for (const request of selected) {
            tx.require(request, "create");
            tx.create(
              request,
              request.area.prefix,
              personnelPart(row, personnelDomain(request.area.domain)!.facet),
            );
          }
        });
        live();
        await shareNewPersonnelName(client, id, signal);
        live();
        await (
          await import("../crypto/absenceDefaults")
        ).synchronizeAbsenceDefaults(client, signal, driver);
        live();
        return { id };
      }
      const data = partialAddressRecord(input, ["id", "data"]);
      addressId(data.id);
      const id = data.id as string,
        changes = personnelChanges(data.data),
        available = await requests();
      const columns = Object.keys(changes),
        edited = PERSONNEL_FACETS.filter((facet) =>
          columns.some((column) => personnelColumns(facet).includes(column)),
        ).map((facet) => personnelRequest(id, facet));
      const basic = edited.some(
          (request) => request.area.facet === "master-data",
        ),
        plan = await supervisorPlan(id, changes.supervisor_user_id, available);
      const relevant = ["contract_type", "supervisor_user_id"].filter(
        (column) => Object.hasOwn(changes, column),
      );
      const controls =
        relevant.length > 0 &&
        (await runtime.read(edited, (view) =>
          relevant.some(
            (column) =>
              view.row("users", { id: addressId(id) }).require(column) !==
              changes[column],
          ),
        ));
      const defaults = controls
        ? await (
            await import("../crypto/absenceDefaults")
          ).absenceDefaultPlan(client, signal)
        : null;
      const renaming =
        Object.hasOwn(changes, "username") &&
        (await runtime.read(
          edited,
          (view) =>
            view.row("users", { id: addressId(id) }).require("username") !==
            changes.username,
        ));
      live();
      const rename = renaming
        ? await memberLifecycle(
            client,
            id,
            "rename",
            signal,
            changes.username as string,
          )
        : null;
      const change = (tx: import("./runtime/runtime").DataTransaction) => {
        live();
        for (const request of edited) tx.require(request, "update");
        if (rename) requireMemberStatus(tx, id, rename.status);
        else if (Object.hasOwn(changes, "username")) {
          if (
            tx.row("users", { id: addressId(id) }).require("username") !==
            changes.username
          ) {
            throw new ProtectedWriteConflict();
          }
          delete changes.username;
        }
        checkSupervisor(tx, id, changes.supervisor_user_id, plan.chainIds);
        if (
          !defaults &&
          relevant.some(
            (column) =>
              tx.row("users", { id: addressId(id) }).require(column) !==
              changes[column],
          )
        )
          throw new ProtectedWriteConflict();
        if (Object.keys(changes).length)
          tx.patch(
            "users",
            { id: addressId(id) },
            {
              ...changes,
              ...(basic ? { modified_at: new Date().toISOString() } : {}),
            },
          );
      };
      if (defaults || rename) {
        const prepared = await runtime.prepare(
          [...edited, ...plan.selected, ...(defaults?.selected ?? [])],
          (tx) => {
            change(tx);
            return defaults ? defaults.next(tx) : null;
          },
        );
        try {
          const masterPacket = prepared.groups
            .flatMap((group) => group.packets)
            .find(
              (packet) =>
                packet.domain === personnelCollection(id, "master-data").domain,
            );
          const member =
            rename && masterPacket
              ? await rename.publication(masterPacket)
              : undefined;
          if (rename && !member) throw new InvalidProtectedData();
          await commitProtectedWrites(
            client,
            prepared.groups,
            signal,
            prepared.guards,
            {
              ...(defaults
                ? { policy: defaults.publication(prepared.value!) }
                : {}),
              ...(member ? { member } : {}),
            },
          );
        } finally {
          prepared.close();
        }
        if (defaults) await finishAccessChanges(client, signal);
        if (rename) {
          const current = unlockedAccount();
          if (current?.vault.subject === `user:${id}`)
            current.username = changes.username as string;
          await client.invalidate("auth.sessionInfo");
        }
      } else await runtime.transaction([...edited, ...plan.selected], change);
      live();
      return { success: true as const };
    },
  };
}
