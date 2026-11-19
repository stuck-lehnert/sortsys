import assert from "node:assert/strict";
import type { Client, QueryResult } from "@sortsys/v2-client";
import {
  base64,
  certifyIdentity,
  publicIdentity,
  signingPair,
} from "@sortsys/zerotrust/sortsys";
import {
  acceptVaultWithKey,
  enrollPasswordAccount,
  trustedHistory,
  unlockedAccount,
} from "../app/lib/crypto/session";
import { administratorContext } from "../app/lib/crypto/administration";
import {
  publishVerifiedPolicy,
  readVerifiedPolicy,
} from "../app/lib/crypto/policy";
import {
  approveMemberInvitation,
  createMemberInvitation,
  signInMemberInvitation,
} from "../app/lib/crypto/invitations";
import { createBusinessClient } from "../app/lib/data/businessClient";
import {
  watchEncryptedEvents,
  type EncryptedChange,
} from "../app/lib/data/events";
import {
  protectedCollection,
  required,
} from "../app/lib/data/protectedObjects";
import {
  scheduleCollection,
  scheduleObject,
  schedulePayload,
} from "../app/lib/data/projectScheduleData";
import { addressId } from "../app/lib/data/addressBook";
import { readOwnAssignments } from "../app/lib/data/planningRecipients";
import { acquireDataRuntime } from "../app/lib/data/runtime/session";
import { duckDriver } from "../app/lib/data/testing/duckDriver.mjs";

const MEMBER_PASSWORD = "Renewed-private-planning-password-2026!";
export type PlanningScenario = {
  tenant: string;
  member: { id: string; username: string; password: string };
  project: { id: string; title: string };
  hiddenProjectId: string;
};

async function until(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Real crypto and DuckDB persistence through two API replicas. The two
 * account vaults never coexist as the active browser identity. */
export async function exerciseNativePlanningRecipients(
  owner: Client,
  member: Client,
  transmissions: readonly string[][],
) {
  const controller = new AbortController();
  const signal = controller.signal;
  let ownerAccount = unlockedAccount()!;
  let colleague: typeof ownerAccount;
  const range = {
    from: new Date("2026-11-01T00:00:00Z"),
    to: new Date("2026-12-01T00:00:00Z"),
  };
  const business = createBusinessClient(owner, { productDriver: duckDriver });
  const restoreOwner = async () => {
    await acceptVaultWithKey(
      ownerAccount.dataKey,
      ownerAccount.vault,
      ownerAccount.username,
      false,
    );
    ownerAccount = unlockedAccount()!;
  };
  const restoreMember = async () => {
    await acceptVaultWithKey(
      colleague.dataKey,
      colleague.vault,
      colleague.username,
      false,
    );
    colleague = unlockedAccount()!;
  };
  try {
    const person = await required(
      business.mutate("users.create", {
        username: "planning.member",
        firstName: "Einsatz",
        lastName: "Mitarbeiter",
        email: null,
        phone: null,
        costPerHour: 67.5,
        vacationDaysPerYear: 28,
        contractType: "internal",
        supervisorUserId: null,
      }),
    );
    const project = await required(
      business.mutate("projects.create", { title: "Private Baustelle 647823" }),
    );
    const target = await required(
      business.mutate("projects.create", { title: "Zielbaustelle 381694" }),
    );
    const first = await required(
      business.mutate("projects.deployments.create", {
        projectId: project.id,
        userId: person.id,
        from: new Date("2026-11-18T08:00:00Z"),
        to: new Date("2026-11-18T16:00:00Z"),
        note: "Private own planning 816294",
      }),
    );
    const other = await required(
      business.mutate("projects.deployments.create", {
        projectId: project.id,
        userId: ownerAccount.vault.subject.slice(5),
        from: new Date("2026-11-19T08:00:00Z"),
        to: new Date("2026-11-19T16:00:00Z"),
        note: "Other person's private planning 749281",
      }),
    );
    const area = scheduleCollection(project.id);
    const object = scheduleObject(project.id, "deployment", first.id);
    const before = await required(
      owner.query("zerotrust.objects.recipientAccess", { objects: [object] }),
    );
    assert.equal(before[0]!.access.active, false);
    const invitation = await createMemberInvitation(
      owner,
      { id: person.id, username: "planning.member" },
      {
        catalogue: "none",
        customers: "none",
        contacts: "none",
        vendors: "none",
        prices: "none",
        assistant: false,
      },
      signal,
    );
    await signInMemberInvitation(
      member,
      invitation.link,
      "Private-planning-member-password-2026!",
      signal,
    );
    colleague = unlockedAccount()!;
    await restoreOwner();
    const lease = acquireDataRuntime(owner, signal, duckDriver);
    try {
      await approveMemberInvitation(
        owner,
        invitation.link.invitation.id,
        signal,
      );
    } finally {
      lease.close();
    }
    const after = await required(
      owner.query("zerotrust.objects.recipientAccess", { objects: [object] }),
    );
    assert.equal(after[0]!.access.active, true);
    assert.equal(after[0]!.recipientKey!.recipient.user, `user:${person.id}`);
    const authority = await administratorContext(owner, signal);

    const collection = await protectedCollection(owner, area, signal);
    let update: Awaited<ReturnType<typeof collection.packet>>;
    let head: string;
    try {
      await collection.read();
      const previous = await collection.get(object);
      const changed = structuredClone(
        schedulePayload(previous.value, object, project.id),
      );
      changed.row.values.note = "Updated private own planning 163829";
      update = await collection.packet(object, changed, previous.envelope);
      head = collection.snapshot();
      const { resourceAccess, ...stripped } = update;
      const rejected = [
        stripped,
        { ...update, recipientKey: undefined },
        {
          ...update,
          resourceAccess: {
            ...resourceAccess!,
            signature: base64(new Uint8Array(64)),
          },
        },
      ];
      for (const packet of rejected) {
        const [, error] = await owner.mutate("zerotrust.objects.batch", {
          objects: [packet],
          heads: [{ domain: area.domain, sequence: head }],
        });
        assert.ok(error);
        const current = await required(
          owner.query(
            "zerotrust.objects.get",
            { id: object },
            { strategy: "network-only" },
          ),
        );
        assert.equal(current.signature, previous.envelope.signature);
      }
    } finally {
      collection.close();
    }

    await restoreMember();
    const history = await trustedHistory(member);
    const previousCertificate = history.identityCertificate(
      `user:${person.id}`,
    );
    const renewedIdentity = {
      ...colleague.identity,
      signingKey: await signingPair(),
    };
    const renewedCertificate = await certifyIdentity(
      {
        tenant: colleague.tenant,
        generation: history.current.generation,
        user: `user:${person.id}`,
        ...(await publicIdentity(renewedIdentity)),
        previousSignature: previousCertificate.signature,
      },
      authority.authority,
    );
    await enrollPasswordAccount(member, {
      tenant: colleague.tenant,
      username: colleague.username,
      subject: `user:${person.id}`,
      password: MEMBER_PASSWORD,
      identity: renewedIdentity,
      replacementCertificate: renewedCertificate,
    });
    colleague = unlockedAccount()!;
    assert.notEqual(
      renewedCertificate.signature,
      after[0]!.recipientKey!.recipient.signature,
    );
    const queries: string[] = [];
    const observed: Client = {
      ...member,
      query: ((path, input, options) => {
        queries.push(path);
        return member.query(path, input, options);
      }) as Client["query"],
    };
    const own = await readOwnAssignments(observed, signal);
    assert.deepEqual(
      own.map((document) => document.value.row.values.id),
      [addressId(first.id)],
    );
    assert.equal(own.length, 1);
    assert.equal(own[0]!.id, object);
    assert.equal(own[0]!.value.projectTitle, "Private Baustelle 647823");
    assert.equal(own[0]!.value.row.values.note, "Private own planning 816294");
    assert.equal(
      queries.some(
        (path) =>
          path === "zerotrust.keys.get" || path === "zerotrust.keys.history",
      ),
      false,
    );
    assert.ok(
      (
        await member.mutate("zerotrust.objects.batch", {
          objects: [update!],
          heads: [{ domain: area.domain, sequence: head! }],
        })
      )[1],
      "A recipient must not publish an owner's packet or gain area writes",
    );
    for (const [path, input] of [
      [
        "zerotrust.objects.get",
        { id: scheduleObject(project.id, "deployment", other.id) },
      ],
      [
        "zerotrust.objects.list",
        {
          domain: area.domain,
          prefix: area.prefix,
          after: null,
          snapshot: null,
        },
      ],
      ["zerotrust.keys.get", { domain: area.domain, generation: "1" }],
      ["zerotrust.objects.recipientAccess", { objects: [object] }],
      ["zerotrust.objects.get", { id: `project:${project.id}` }],
      [
        "zerotrust.domains.proof",
        { domain: `project:${project.id}:master-data`, generation: "1" },
      ],
      ["zerotrust.planningTitles.audience", { project: project.id }],
    ] as const) {
      const [value, error] = await member.queryDynamic(path, input, {
        strategy: "network-only",
      });
      assert.equal(value, null);
      assert.ok(error, `${path} must not grant the parent planning area`);
    }
    const memberBusiness = createBusinessClient(observed, {
      productDriver: duckDriver,
    });
    try {
      const values = await required(
        memberBusiness.query("projects.deployments.list", range),
      );
      assert.deepEqual(
        values.map((value) => value.id),
        [first.id],
      );
      assert.ok(
        (
          await memberBusiness.mutate("projects.deployments.delete", {
            id: first.id,
          })
        )[1],
      );
    } finally {
      memberBusiness.dispose();
    }

    const changes: EncryptedChange[] = [];
    const events = new AbortController();
    let admitted = false;
    const endpoints: string[] = JSON.parse(
      process.env.SORTSYS_AUTH_TEST_ENDPOINTS!,
    );
    const watching = watchEncryptedEvents(
      member,
      endpoints[1]!,
      (change) => changes.push(change),
      events.signal,
      () => {
        admitted = true;
      },
    );
    const subscriber = createBusinessClient(member, {
      productDriver: duckDriver,
      endpoint: endpoints[1],
      realtime: true,
    });
    let latest: QueryResult<"projects.deployments.list"> | null = null;
    let streamError: Error | null = null;
    const subscription = subscriber
      .streamQuery("projects.deployments.list", range)
      .subscribe(([rows, error]) => {
        latest = rows;
        streamError = error;
      });
    try {
      await until(
        () => admitted,
        "The member socket must reach its authenticated baseline",
      );
      await until(
        () => latest?.[0]?.note === "Private own planning 816294",
        "The ordinary planning stream must load the member's own record",
      );
      assert.ifError(streamError);
      await required(
        owner.mutate("zerotrust.objects.batch", {
          objects: [update!],
          heads: [{ domain: area.domain, sequence: head! }],
        }),
      );
      await until(
        () =>
          changes.some((change) => Object.hasOwn(change.domains, area.domain)),
        "An own-record change from the first API must reach the member on the second API",
      );
      const targeted = changes.find((change) =>
        Object.hasOwn(change.domains, area.domain),
      )!;
      assert.equal(targeted.all, false);
      assert.equal(targeted.control, false);
      assert.equal(
        JSON.stringify(changes).includes("Updated private own planning"),
        false,
      );
      const fresh = await readOwnAssignments(member, signal);
      assert.equal(
        fresh[0]!.value.row.values.note,
        "Updated private own planning 163829",
      );
      await until(
        () => latest?.[0]?.note === "Updated private own planning 163829",
        "The ordinary planning stream must refresh automatically through the other API's event",
      );
      assert.ifError(streamError);
      assert.deepEqual(
        latest!.map((row) => row.id),
        [first.id],
      );
    } finally {
      subscription.unsubscribe();
      subscriber.dispose();
      events.abort();
      await watching;
    }

    const beforeRename = await readOwnAssignments(member, signal);
    await restoreOwner();
    const second = await required(
      business.mutate("projects.deployments.create", {
        projectId: project.id,
        userId: person.id,
        from: new Date("2026-11-12T06:00:00Z"),
        to: new Date("2026-11-12T15:00:00Z"),
        note: null,
      }),
    );
    const renamed = "Umbenannte Baustelle 649377";
    const untrustedAudience: Client = {
      ...owner,
      query: (async (path, input, options) => {
        if (path !== "zerotrust.planningTitles.audience")
          return owner.query(path, input, options);
        const [value, error] = await owner.query(path, input, options);
        if (!value || error) return [value, error];
        const audience =
          value as QueryResult<"zerotrust.planningTitles.audience">;
        const recipients = audience.recipients.map((recipient) => ({
          ...recipient,
          proofs: [],
        }));
        return [{ ...audience, recipients }, null];
      }) as Client["query"],
    };
    const untrustedBusiness = createBusinessClient(untrustedAudience, {
      productDriver: duckDriver,
    });
    try {
      const [, error] = await untrustedBusiness.mutate("projects.update", {
        id: project.id,
        data: { title: renamed },
      });
      assert.ok(
        error,
        "The browser must reject an audience without signed planning writer evidence",
      );
    } finally {
      untrustedBusiness.dispose();
    }
    await required(
      business.mutate("projects.update", {
        id: project.id,
        data: { title: renamed },
      }),
    );
    await restoreMember();
    const page = await required(
      member.query(
        "zerotrust.objects.shared",
        {
          prefix: `schedule:${project.id}:deployment:`,
          after: null,
          snapshot: null,
        },
        { strategy: "network-only" },
      ),
    );
    assert.equal(page.objects.length, 2);
    assert.equal(page.projectTitles?.length, 1);
    assert.equal(JSON.stringify(page).includes(renamed), false);
    queries.length = 0;
    const transmissionsBefore = transmissions.length;
    const renamedAssignments = await readOwnAssignments(
      observed,
      signal,
      project.id,
    );
    assert.deepEqual(
      renamedAssignments.map((assignment) => assignment.value.projectTitle),
      [renamed, renamed],
    );
    assert.equal(
      renamedAssignments.find((assignment) => assignment.id === object)
        ?.revision,
      beforeRename[0]!.revision,
    );
    assert.equal(
      queries.filter((path) => path === "zerotrust.objects.shared").length,
      1,
    );
    assert.equal(queries.includes("zerotrust.domains.proof"), false);
    const reads = transmissions
      .slice(transmissionsBefore)
      .filter(
        (paths) =>
          paths.includes("zerotrust.access.snapshot") ||
          paths.includes("zerotrust.objects.shared"),
      );
    assert.equal(reads.length, 1);
    assert.ok(reads[0]!.includes("zerotrust.access.snapshot"));
    assert.ok(reads[0]!.includes("zerotrust.objects.shared"));
    await restoreOwner();
    await required(
      business.mutate("projects.deployments.delete", { id: second.id }),
    );

    const policyContext = await administratorContext(owner, signal);
    const baseline = await readVerifiedPolicy(owner, policyContext);
    await publishVerifiedPolicy(owner, policyContext, {
      ...baseline.permissions,
      version: (BigInt(baseline.permissions.version) + 1n).toString(),
      rules: [
        ...baseline.permissions.rules,
        {
          subject: `user:${person.id}`,
          scope: area.scope,
          facet: area.facet,
          actions: ["read"],
          effect: "deny",
        },
      ],
    });
    await restoreMember();
    assert.deepEqual(await readOwnAssignments(member, signal), []);
    await restoreOwner();
    const allowedContext = await administratorContext(owner, signal);
    const denied = await readVerifiedPolicy(owner, allowedContext);
    await publishVerifiedPolicy(owner, allowedContext, {
      ...baseline.permissions,
      version: (BigInt(denied.permissions.version) + 1n).toString(),
    });
    await required(
      business.mutate("projects.deployments.update", {
        id: first.id,
        data: { projectId: target.id },
      }),
    );
    await restoreMember();
    const moved = await readOwnAssignments(member, signal);
    assert.equal(moved.length, 1);
    assert.equal(moved[0]!.value.row.values.project_id, addressId(target.id));
    assert.equal(moved[0]!.value.projectTitle, "Zielbaustelle 381694");
    await restoreOwner();
    await required(
      business.mutate("projects.deployments.update", {
        id: first.id,
        data: { userId: ownerAccount.vault.subject.slice(5) },
      }),
    );
    await restoreMember();
    assert.deepEqual(await readOwnAssignments(member, signal), []);
    await restoreOwner();
    await required(
      business.mutate("projects.deployments.update", {
        id: first.id,
        data: { userId: person.id },
      }),
    );
    await required(
      business.mutate("projects.deployments.delete", { id: first.id }),
    );
    await restoreMember();
    assert.deepEqual(await readOwnAssignments(member, signal), []);
    console.log(
      "Own planning: pre-enrollment assignments become readable after approval without parent keys; signing renewal retains access; other records and writes are denied; stripped proofs publish nothing; cross-instance events, project captions, updates, moves, reassignment and deletion verified",
    );
    return {
      tenant: ownerAccount.tenant,
      member: {
        id: person.id,
        username: "planning.member",
        password: MEMBER_PASSWORD,
      },
      project: { id: target.id, title: "Zielbaustelle 381694" },
      hiddenProjectId: project.id,
    } satisfies PlanningScenario;
  } finally {
    controller.abort();
    await restoreOwner();
    business.dispose();
  }
}
