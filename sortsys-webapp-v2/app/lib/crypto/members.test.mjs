import { afterEach, expect, test } from "bun:test";
import {
  base64,
  createAccountVault,
  createIdentity,
  createTenantSetup,
} from "@sortsys/zerotrust/sortsys";
import { administratorContext } from "./administration";
import {
  createMemberAccount,
  decodeMemberStatus,
  memberCreationFrame,
  memberStateAfter,
  memberLifecycle,
  memberChangeFrame,
} from "./members";
import { acceptVault, lockCryptoSession } from "./session";
import { timestampMicros } from "../data/timestamps";

afterEach(() => lockCryptoSession());
const PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
async function fixture() {
  const identity = await createIdentity(),
    { setup } = await createTenantSetup("test", "user:1", identity, PHRASE, {
      scopes: [],
    });
  const exportKey = base64(crypto.getRandomValues(new Uint8Array(64))),
    vault = await createAccountVault(exportKey, "test", "user:1", identity, {
      recoveryGeneration: "1",
      recoverySigningKey: setup.authority.recoverySigningKey,
    });
  await acceptVault(exportKey, vault, "owner", false);
  let saved = null,
    change = null,
    permissions = setup.policy;
  const calls = [],
    client = {
      loggedIn: () => true,
      async query(path) {
        calls.push(path);
        if (path === "auth.sessionInfo")
          return [
            {
              user: { id: "1", username: "owner", locale: "en" },
              roles: [":admin"],
            },
            null,
          ];
        if (path === "zerotrust.trust.history")
          return [
            {
              authorities: [{ certificate: setup.authority, transition: null }],
              identities: [setup.owner],
            },
            null,
          ];
        if (path === "zerotrust.status") return [{ profile: setup }, null];
        if (path === "zerotrust.members.creation")
          return saved ? [saved, null] : [null, new Error("No reservation")];
        if (path === "zerotrust.policy.get") return [permissions, null];
        if (path === "zerotrust.members.status")
          return [
            {
              id: "4",
              username: "anna.muster",
              version: base64(new Uint8Array(32)),
              atMicros: timestampMicros(
                "2026-11-12T02:00:00.123456Z",
              ).toString(),
              deactivatedMicros: null,
              archivedMicros: null,
            },
            null,
          ];
        if (path === "zerotrust.members.changeReceipt") return [change, null];
        throw new Error("Unexpected query " + path);
      },
      async mutate(path, input) {
        calls.push(path);
        saved = {
          creation: input,
          createdAt: new Date("2026-11-12T01:00:00Z"),
        };
        return [{ success: true }, null];
      },
    };
  return {
    client,
    calls,
    get: () => saved,
    set: (value) => {
      saved = value;
    },
    setChange: (value) => {
      change = value;
    },
    setPolicy: (value) => {
      permissions = value;
    },
  };
}
test("technical account creation confirms exact signed reservations after positive and lost replies", async () => {
  const { client, get } = await fixture(),
    signal = new AbortController().signal;
  expect(
    (await createMemberAccount(client, "4", "anna.muster", signal)).id,
  ).toBe("4");
  expect(
    (await createMemberAccount(client, "4", "anna.muster", signal)).locale,
  ).toBe("de");
  expect(Object.keys(get().creation).sort()).toEqual([
    "author",
    "generation",
    "id",
    "proof",
    "tenant",
    "username",
  ]);
  const mutate = client.mutate;
  client.mutate = async (...args) => {
    await mutate(...args);
    return [null, new Error("Lost reply")];
  };
  expect(
    (await createMemberAccount(client, "5", "max.muster", signal)).username,
  ).toBe("max.muster");
});
test("false account creation acknowledgements and substituted reservations are rejected", async () => {
  const data = await fixture(),
    signal = new AbortController().signal;
  data.client.mutate = async () => [{ success: true }, null];
  await expect(
    createMemberAccount(data.client, "4", "anna.muster", signal),
  ).rejects.toThrow();
  data.client.mutate = async (_, input) => {
    data.set({
      creation: { ...input, username: "other.person" },
      createdAt: new Date(),
    });
    return [{ success: true }, null];
  };
  await expect(
    createMemberAccount(data.client, "4", "anna.muster", signal),
  ).rejects.toThrow();
});
test("administration rejects a substituted actor even with a technical administrator role", async () => {
  const { client, calls } = await fixture(),
    query = client.query;
  client.query = (path) =>
    path === "auth.sessionInfo"
      ? Promise.resolve([
          { user: { id: "2", username: "owner" }, roles: [":admin"] },
          null,
        ])
      : query(path);
  await expect(
    administratorContext(client, new AbortController().signal),
  ).rejects.toThrow();
  expect(calls).not.toContain("zerotrust.status");
});
test("account reservation frames reject ambiguous usernames and noncanonical identifiers", () => {
  const value = {
    tenant: "test",
    generation: "1",
    author: "user:1",
    id: "4",
    username: "anna.muster",
  };
  expect(memberCreationFrame(value)).toBeInstanceOf(Uint8Array);
  for (const username of [
    "",
    "Anna",
    ".anna",
    "anna.",
    "anna..muster",
    "a/b",
    "a".repeat(64),
  ])
    expect(() => memberCreationFrame({ ...value, username })).toThrow();
  for (const id of ["0", "04", "-1"])
    expect(() => memberCreationFrame({ ...value, id })).toThrow();
});

test("lifecycle transitions preserve deactivation when unarchiving and reject active archives", () => {
  const current = {
    id: "4",
    version: "test",
    at: "2026-11-12T02:00:00.123456Z",
    deactivatedAt: null,
    archivedAt: null,
  };
  expect(memberStateAfter(current, "deactivate")).toEqual({
    deactivated_at: current.at,
    archived_at: null,
  });
  expect(() => memberStateAfter(current, "archive")).toThrow();
  const inactive = { ...current, deactivatedAt: "2026-11-12T01:00:00.654321Z" };
  expect(memberStateAfter(inactive, "archive")).toEqual({
    deactivated_at: inactive.deactivatedAt,
    archived_at: inactive.at,
  });
  expect(
    memberStateAfter({ ...inactive, archivedAt: inactive.at }, "unarchive"),
  ).toEqual({ deactivated_at: inactive.deactivatedAt, archived_at: null });
  expect(
    memberStateAfter({ ...inactive, archivedAt: inactive.at }, "activate"),
  ).toEqual({ deactivated_at: null, archived_at: null });
});

test("a stored change receipt cannot replace confirmation of the signed suspension", async () => {
  const data = await fixture(),
    controller = new AbortController();
  const control = await memberLifecycle(
    data.client,
    "4",
    "deactivate",
    controller.signal,
  );
  const publication = await control.publication({
    domain: "personnel:4:master-data",
    envelope: {
      object: "personnel:4:master-data:record",
      policyVersion: "1",
      signature: base64(new Uint8Array(64)),
    },
  });
  data.setChange(publication.change);
  expect(await publication.verify()).toBe(false);
  data.setPolicy(publication.change.permissions);
  expect(await publication.verify()).toBe(true);
});

test("renaming binds a canonical login alias without changing the signed permission policy", async () => {
  const data = await fixture();
  const control = await memberLifecycle(
    data.client,
    "4",
    "rename",
    new AbortController().signal,
    "anna.updated",
  );
  expect(control.status.username).toBe("anna.muster");
  expect(control.unchanged).toBe(false);
  const publication = await control.publication({
    domain: "personnel:4:master-data",
    envelope: {
      object: "personnel:4:master-data:record",
      policyVersion: "1",
      signature: base64(new Uint8Array(64)),
    },
  });
  expect(publication.change.username).toBe("anna.updated");
  expect(publication.change.permissions).toBeUndefined();
  expect(await publication.verify()).toBe(false);
  data.setChange(publication.change);
  expect(await publication.verify()).toBe(true);
  data.setChange({ ...publication.change, username: "anna.other" });
  expect(await publication.verify()).toBe(false);
  expect(() =>
    memberChangeFrame({ ...publication.change, username: ".invalid" }),
  ).toThrow();
  expect(() =>
    memberChangeFrame({ ...publication.change, username: undefined }),
  ).toThrow();
  expect(() =>
    memberChangeFrame({ ...publication.change, action: "archive" }),
  ).toThrow();
});

test("recovery aliases and ordinary names with hyphens remain editable", () => {
  const status = decodeMemberStatus({
    id: "4",
    username: "recovery-4",
    version: base64(new Uint8Array(32)),
    atMicros: "123456789",
    deactivatedMicros: null,
    archivedMicros: null,
  });
  expect(status.username).toBe("recovery-4");
  expect(() =>
    memberCreationFrame({
      tenant: "test",
      generation: "1",
      author: "user:1",
      id: "4",
      username: "anna-muster",
    }),
  ).not.toThrow();
});
