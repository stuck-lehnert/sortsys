import { expect, test } from "bun:test";
import {
  allows,
  CREATION_FACETS,
  creationResource,
} from "@sortsys/zerotrust/sortsys";
import { creationFixture } from "../../../../sortsys-zerotrust/test/support/creationFixture";
import { createdAccess, verifyCreatedAccess } from "./createdAccess";

test("point reads verify certified creation rights for every declared resource namespace and retain root denials", async () => {
  for (const namespace of Object.keys(CREATION_FACETS)) {
    const f = await creationFixture(namespace),
      domain = f.origin.id,
      calls = [];
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
    const client = {
      async query(path, input) {
        calls.push({ path, input });
        return [f.origin, null];
      },
    };
    const history = {
      authority: () => f.authorityKey.publicKey,
      current: { generation: "1" },
    };
    const effective = await createdAccess(
      client,
      permissions,
      history,
      new AbortController().signal,
      domain,
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
    expect(calls).toEqual([
      { path: "zerotrust.creations.origin", input: { domain } },
    ]);
    expect(creationResource(f.origin.scope)).toEqual({ namespace, id: "abc" });
    await expect(
      createdAccess(
        {
          async query() {
            return [
              {
                ...f.origin,
                id: `${namespace}:def:master-data`,
                scope: `${namespace}:def`,
              },
              null,
            ];
          },
        },
        permissions,
        history,
        new AbortController().signal,
        domain,
      ),
    ).rejects.toThrow();
  }
});

test("unrelated catalogues and invalid resource identifiers cannot trigger or acquire delegated grants", async () => {
  const permissions = { tenant: "test", version: "1", rules: [] },
    client = {
      async query() {
        throw new Error("No namespace lookup expected");
      },
    };
  expect(
    await createdAccess(
      client,
      permissions,
      {},
      new AbortController().signal,
      "catalog:tools:master-data",
    ),
  ).toBe(permissions);
  for (const scope of [
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
});
