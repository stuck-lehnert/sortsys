import { expect, test } from "bun:test";
import {
  allows,
  CREATION_FACETS,
  creationResource,
} from "@sortsys/zerotrust/sortsys";
import { creationFixture } from "../../../../sortsys-zerotrust/test/support/creationFixture";
import { verifyCreatedAccess } from "./createdAccess";

test("inventories verify creation rights for each resource namespace and retain root denials", async () => {
  for (const namespace of Object.keys(CREATION_FACETS)) {
    const f = await creationFixture(namespace);
    const selected = new Set([f.origin.id]);
    const permissions = {
      tenant: "test",
      version: "1",
      rules: [
        {
          subject: "user:2",
          scope: f.origin.scope,
          facet: "master-data",
          actions: ["update"],
          effect: "deny",
        },
      ],
    };
    const history = {
      authority: () => f.authorityKey.publicKey,
      current: { generation: "1" },
    };
    const signal = new AbortController().signal;
    const { permissions: effective } = await verifyCreatedAccess(
      [f.origin],
      permissions,
      history,
      signal,
      selected,
    );
    const request = {
      tenant: "test",
      version: "1",
      subjects: ["user:2"],
      scope: f.origin.scope,
      facet: "master-data",
      action: "read",
    };
    expect(allows(effective, request)).toBe(true);
    expect(allows(effective, { ...request, action: "grant" })).toBe(false);
    expect(allows(effective, { ...request, action: "update" })).toBe(false);
    expect(allows(effective, { ...request, scope: `${namespace}:def` })).toBe(
      false,
    );
    expect(creationResource(f.origin.scope)).toEqual({ namespace, id: "abc" });

    const signature = f.origin.signature;
    const tamperedSignature = (signature[0] === "A" ? "B" : "A") + signature.slice(1);
    await expect(
      verifyCreatedAccess(
        [{ ...f.origin, signature: tamperedSignature }],
        permissions,
        history,
        signal,
        selected,
      ),
    ).rejects.toThrow();
  }
});

test("an empty inventory adds no grants, and invalid resource scopes grant nothing", async () => {
  const policy = { tenant: "test", version: "1", rules: [] };
  const history = {
    authority() {
      throw new Error("No origin to verify");
    },
    current: { generation: "1" },
  };
  const { origins, permissions } = await verifyCreatedAccess(
    [],
    policy,
    history,
    new AbortController().signal,
  );

  expect(origins).toEqual([]);
  expect(permissions).toBe(policy);

  for (const scope of [
    "catalog:tools:master-data",
    "tool:0",
    "tool:01",
    "tool:8000000000000",
    "tool:abc:extra",
    "other:abc",
    "__proto__:abc",
  ])
    expect(creationResource(scope)).toBeNull();
});

test("a selected batch accepts only unique creation proofs for the requested domains", async () => {
  const fixture = await creationFixture("commercial");
  const policy = { tenant: "test", version: "1", rules: [] };
  const history = {
    authority: () => fixture.authorityKey.publicKey,
    current: { generation: "1" },
  };
  const signal = new AbortController().signal;
  const selected = new Set([fixture.origin.id]);
  const { origins, permissions } = await verifyCreatedAccess(
    [fixture.origin],
    policy,
    history,
    signal,
    selected,
  );
  expect(origins).toEqual([fixture.origin]);
  expect(
    allows(permissions, {
      tenant: "test",
      version: "1",
      subjects: ["user:2"],
      scope: fixture.origin.scope,
      facet: "master-data",
      action: "read",
    }),
  ).toBe(true);
  await expect(
    verifyCreatedAccess(
      [fixture.origin, fixture.origin],
      policy,
      history,
      signal,
      selected,
    ),
  ).rejects.toThrow();
  await expect(
    verifyCreatedAccess(
      [fixture.origin],
      policy,
      history,
      signal,
      new Set(["commercial:def:master-data"]),
    ),
  ).rejects.toThrow();
  await expect(
    verifyCreatedAccess([null], policy, history, signal, selected),
  ).rejects.toThrow();
});
