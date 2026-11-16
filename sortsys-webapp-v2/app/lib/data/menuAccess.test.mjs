import { afterEach, expect, test } from "bun:test";
import {
  ACTIONS,
  base64,
  createAccountVault,
  createIdentity,
  createTenantSetup,
  policy,
  signPolicy,
} from "@sortsys/zerotrust/sortsys";
import { acceptVault, lockCryptoSession } from "../crypto/session";
import { accessSnapshotFixture } from "./testing/accessSnapshot.mjs";
import {
  createContentAccess,
  projectMenuAccess,
  protectedMenuRole,
  readMenuAccess,
} from "./menuAccess";

afterEach(() => lockCryptoSession());
const PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

test("client script navigation needs its own grant and separates creation from editing", () => {
  const addressOnly = project([
    rule("organization", "master-data", [...ACTIONS]),
  ]);
  expect(addressOnly.role("view:clientScripts")).toBe(false);
  const scripts = project([
    rule("organization:scripts", "master-data", ["read", "create", "delete"]),
  ]);
  expect(protectedMenuRole("view:clientScripts")).toBe(true);
  expect(scripts.role("view:clientScripts")).toBe(true);
  expect(scripts.role("manage:clientScripts")).toBe(false);
  expect(scripts.role("delete:clientScripts")).toBe(true);
  expect(scripts.canCreate("clientScripts")).toBe(true);
});
const rule = (scope, facet, actions, effect = "allow", subject = "user:1") => ({
  subject,
  scope,
  facet,
  actions,
  effect,
});
const project = (rules) =>
  projectMenuAccess(policy({ tenant: "test", version: "1", rules }), "user:1");
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test("absence navigation requires both key areas and distinguishes own requests from management", () => {
  const own = project([
    rule("absence:1", "master-data", ["read", "create", "delete"]),
    rule("absence:1", "personnel", ["read"]),
  ]);
  expect(own.role("view:userVacations")).toBe(true);
  expect(own.canCreate("absence")).toBe(true);
  expect(own.role("manage:userVacations")).toBe(false);
  const decider = project([
    rule("absence:2", "master-data", ["read"]),
    rule("absence:2", "personnel", ["read", "approve"]),
  ]);
  expect(decider.role("view:userVacations")).toBe(true);
  expect(decider.canCreate("absence")).toBe(false);
  expect(decider.role("manage:userVacations")).toBe(false);
  expect(
    project([
      rule("absence:2", "master-data", ["read", "create"]),
      rule("absence:2", "personnel", ["read"]),
    ]).role("manage:userVacations"),
  ).toBe(true);
  for (const rules of [
    [rule("absence:1", "master-data", [...ACTIONS])],
    [rule("absence:1", "personnel", [...ACTIONS])],
    [
      rule("absence:1", "master-data", [...ACTIONS]),
      rule("absence:1", "personnel", [...ACTIONS]),
      rule("absence:1", "personnel", ["read"], "deny"),
    ],
  ]) {
    const access = project(rules);
    expect(access.canCreate("absence")).toBe(false);
    expect(access.role("view:userVacations")).toBe(false);
  }
  expect(protectedMenuRole("manage:userVacations")).toBe(true);
});

test("planning grants open only the selected project's planning actions", () => {
  const access = project([
    rule("project:2:planning", "master-data", ["read", "create", "delete"]),
  ]);
  expect(access.role("view:projectDeployments")).toBe(true);
  expect(access.canCreate("project-schedule")).toBe(true);
  expect(access.can("project:2:planning", "master-data", "delete")).toBe(true);
  expect(access.can("project:2:planning", "master-data", "update")).toBe(false);
  expect(access.can("project:8:planning", "master-data", "create")).toBe(false);
  for (const role of [
    "view:projects",
    "view:dailyProjectReports",
    "view:regieReports",
    "view:deliveryNotes",
  ])
    expect(access.role(role)).toBe(false);
  expect(
    project([rule("project:2", "master-data", [...ACTIONS])]).role(
      "view:projectDeployments",
    ),
  ).toBe(false);
});

test("content navigation uses explicit grants, independent prices and dominant denials", () => {
  const view = project([
    rule("catalog:products", "master-data", ["read"]),
    rule("catalog:products", "procurement", [...ACTIONS]),
    rule("catalog:vendors", "master-data", [...ACTIONS], "allow", "user:2"),
    rule("catalog:products", "procurement", ["update"], "deny"),
  ]);
  expect(view.role("view:products")).toBe(true);
  expect(view.role("manage:products")).toBe(false);
  expect(view.role("view:productPriceRecords")).toBe(true);
  expect(view.role("manage:productPriceRecords")).toBe(false);
  expect(view.role("view:productVendors")).toBe(false);
  expect(view.role(":admin")).toBeUndefined();
  expect(view.role(":llm")).toBe(false);
  expect(protectedMenuRole("manage:users")).toBe(true);
  expect(
    project([rule("catalog:contacts", "master-data", ["update"])]).role(
      "manage:contacts",
    ),
  ).toBe(false);
});

test("offer creation and project creation are independent from existing project writes", () => {
  const offers = project([
    rule("create:commercial", "master-data", ["create"]),
  ]);
  expect(offers.canCreate("commercial")).toBe(true);
  expect(offers.canCreate("project")).toBe(false);
  expect(offers.canSeeOffers()).toBe(true);
  expect(offers.role("view:projects")).toBe(false);
  const projects = project([
    rule("project:4", "master-data", [...ACTIONS]),
    rule("project:5", "master-data", ["read"]),
  ]);
  expect(projects.role("manage:projects")).toBe(true);
  expect(projects.canCreate("commercial")).toBe(false);
  expect(projects.can("project:5", "master-data", "update")).toBe(false);
  expect(projects.canAny("project", "attachment", "read")).toBe(false);
  expect(
    project([rule("commercial:8", "master-data", ["read"])]).canSeeOffers(),
  ).toBe(true);
});

test("delivery-note navigation needs explicit project quantities and does not grant procurement", () => {
  const notes = project([
    rule("project:4:delivery-notes", "master-data", ["read", "update"]),
  ]);
  expect(notes.role("view:deliveryNotes")).toBe(true);
  expect(notes.role("manage:deliveryNotes")).toBe(true);
  expect(notes.role("delete:deliveryNotes")).toBe(false);
  expect(notes.canCreate("delivery-note")).toBe(false);
  expect(notes.can("project:4:delivery-notes", "procurement", "read")).toBe(
    false,
  );
  expect(
    project([rule("project:4", "master-data", [...ACTIONS])]).role(
      "view:deliveryNotes",
    ),
  ).toBe(false);
  expect(
    project([
      rule("project:4:delivery-notes", "master-data", ["read", "create"]),
    ]).canCreate("delivery-note"),
  ).toBe(true);
  expect(
    project([
      rule("project:4:delivery-notes", "master-data", [...ACTIONS]),
      rule("project:4:delivery-notes", "master-data", ["read"], "deny"),
    ]).role("manage:deliveryNotes"),
  ).toBe(false);
});

test("daily-report navigation requires its own project grant and never opens internal cost keys", () => {
  const reports = project([
    rule("project:4:daily-reports", "master-data", [
      "read",
      "create",
      "update",
    ]),
  ]);
  expect(reports.role("view:dailyProjectReports")).toBe(true);
  expect(reports.role("manage:dailyProjectReports")).toBe(true);
  expect(reports.role("delete:dailyProjectReports")).toBe(false);
  expect(reports.canCreate("daily-report")).toBe(true);
  expect(reports.can("project:4:daily-reports", "calculation", "read")).toBe(
    false,
  );
  expect(
    project([rule("project:4", "master-data", [...ACTIONS])]).role(
      "view:dailyProjectReports",
    ),
  ).toBe(false);
  expect(
    project([
      rule("project:4:daily-reports", "master-data", [...ACTIONS]),
      rule("project:4:daily-reports", "master-data", ["read"], "deny"),
    ]).role("manage:dailyProjectReports"),
  ).toBe(false);
});

test("regie navigation keeps quantity grants and per-project working-time grants distinct", () => {
  const material = project([
    rule("project:4:regie-reports", "master-data", [
      "read",
      "create",
      "update",
    ]),
  ]);
  expect(material.role("view:regieReports")).toBe(true);
  expect(material.role("manage:regieReports")).toBe(true);
  expect(material.canCreate("regie-report")).toBe(true);
  expect(material.can("project:4:regie-reports", "personnel", "read")).toBe(
    false,
  );
  const hours = project([
    rule("project:4:regie-reports", "master-data", ["read"]),
    rule("project:4:regie-reports", "personnel", ["read", "update"]),
  ]);
  expect(hours.role("manage:regieReports")).toBe(true);
  expect(hours.canCreate("regie-report")).toBe(false);
  expect(
    project([
      rule("project:4:regie-reports", "master-data", ["read"]),
      rule("project:5:regie-reports", "personnel", ["read", "update"]),
    ]).role("manage:regieReports"),
  ).toBe(false);
  expect(
    project([
      rule("project:4:regie-reports", "personnel", ["read", "update"]),
    ]).role("view:regieReports"),
  ).toBe(false);
});

test("tool menus distinguish individual masters, costs, inventories and tracking records", () => {
  const tool = project([rule("tool:4", "master-data", ["read"])]);
  expect(tool.role("view:tools")).toBe(true);
  expect(tool.role("manage:tools")).toBe(false);
  expect(tool.role("view:toolInventories")).toBe(false);
  expect(tool.role("view:toolTrackings")).toBe(false);
  expect(tool.can("tool:4", "procurement", "read")).toBe(false);
  const own = project([
    rule("tool-tracking:5", "master-data", ["read"]),
    rule("tool-tracking:5", "scope", ["read", "create", "update"]),
  ]);
  expect(own.role("view:toolTrackings")).toBe(true);
  expect(own.role("manage:toolTrackings")).toBe(false);
  expect(own.can("tool-tracking:6", "master-data", "read")).toBe(false);
  expect(
    project([rule("tool:4", "measurement", ["read", "update"])]).role(
      "manage:toolInventories",
    ),
  ).toBe(true);
  const index = project([rule("catalog:tools", "master-data", [...ACTIONS])]);
  expect(index.canCreate("tool")).toBe(false);
  const toolCreation = project([
    rule("catalog:tools", "master-data", ["read", "update"]),
    rule("create:tool", "master-data", ["create"]),
  ]);
  expect(toolCreation.canCreate("tool")).toBe(true);
  expect(index.role("view:tools")).toBe(false);
  const oneBooking = project([
    rule("tool-tracking:5", "master-data", [...ACTIONS]),
  ]);
  expect(oneBooking.canCreate("tool-tracking")).toBe(false);
  const newBookings = project([
    rule("create:tool-tracking", "master-data", ["create"]),
  ]);
  expect(newBookings.canCreate("tool-tracking")).toBe(true);
  expect(newBookings.role("view:toolTrackings")).toBe(false);
  const incomplete = project([
    rule("create:tool-tracking", "master-data", ["create"]),
    rule("tool:4", "master-data", ["read", "update"]),
    rule("tool:5", "procurement", ["read"]),
  ]);
  expect(incomplete.canBookTool()).toBe(false);
  expect(incomplete.canBookTool("4")).toBe(false);
  const eligible = project([
    rule("create:tool-tracking", "master-data", ["create"]),
    rule("tool:4", "master-data", ["read", "update"]),
    rule("tool:4", "procurement", ["read"]),
  ]);
  expect(eligible.canBookTool()).toBe(true);
  expect(eligible.canBookTool("4")).toBe(true);
  expect(eligible.canBookTool("5")).toBe(false);
  expect(
    project([
      rule("tool:4", "master-data", ["read", "update"]),
      rule("tool:4", "procurement", ["read"]),
    ]).canBookTool(),
  ).toBe(false);
});

test("personnel menus require name grants for lists and distinguish private field writes", () => {
  const names = project([rule("personnel:4", "master-data", ["read"])]);
  expect(names.role("view:users")).toBe(true);
  expect(names.role("manage:users")).toBe(false);
  const costs = project([
    rule("personnel:4", "calculation", ["read", "update"]),
  ]);
  expect(costs.role("view:users")).toBe(false);
  expect(costs.role("manage:users")).toBe(true);
  expect(costs.can("personnel:4", "master-data", "read")).toBe(false);
  expect(costs.can("personnel:5", "calculation", "update")).toBe(false);
  expect(
    project([
      rule("personnel:4", "scope", ["read", "update"]),
      rule("personnel:4", "scope", ["update"], "deny"),
    ]).role("manage:users"),
  ).toBe(false);
  expect(
    project([rule("personnel:4", "calculation", ["update"])]).role(
      "manage:users",
    ),
  ).toBe(false);
  expect(
    project([
      rule("personnel:4", "master-data", ["read"], "allow", "user:2"),
    ]).role("view:users"),
  ).toBe(false);
});

async function fixture() {
  const identity = await createIdentity(),
    { setup, authorityKey } = await createTenantSetup(
      "test",
      "user:1",
      identity,
      PHRASE,
      { scopes: [] },
    );
  const exportKey = base64(crypto.getRandomValues(new Uint8Array(64)));
  await acceptVault(
    exportKey,
    await createAccountVault(exportKey, "test", "owner", identity, {
      recoveryGeneration: "1",
      recoverySigningKey: setup.authority.recoverySigningKey,
    }),
    false,
  );
  let permissions = await signPolicy(
    {
      tenant: "test",
      version: "1",
      rules: [rule("catalog:vendors", "master-data", ["read"])],
    },
    authorityKey.privateKey,
  );
  const sent = [],
    client = {
      loggedIn: () => true,
      async query(path, input) {
        sent.push(path);
        if (path === "zerotrust.access.snapshot")
          return accessSnapshotFixture(client, input);
        if (path === "auth.sessionInfo")
          return [
            { user: { id: "1", username: "owner" }, roles: [":admin"] },
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
        if (path === "zerotrust.policy.get") return [permissions, null];
        if (path === "zerotrust.creations.list") return [[], null];
        throw new Error("Unexpected menu RPC " + path);
      },
    };
  return {
    client,
    sent,
    get: () => permissions,
    set: (value) => {
      permissions = value;
    },
    sign: (rules) =>
      signPolicy(
        { tenant: "test", version: "2", rules },
        authorityKey.privateKey,
      ),
  };
}

test("menu access verifies signed policy and never requests content keys or business records", async () => {
  const data = await fixture(),
    signal = new AbortController().signal;
  expect(
    (await readMenuAccess(data.client, signal)).role("manage:productVendors"),
  ).toBe(false);
  data.set({
    ...data.get(),
    rules: [rule("catalog:vendors", "master-data", [...ACTIONS])],
  });
  await expect(readMenuAccess(data.client, signal)).rejects.toThrow();
  expect(
    data.sent.every((path) =>
      [
        "zerotrust.access.snapshot",
        "auth.sessionInfo",
        "zerotrust.trust.history",
        "zerotrust.policy.get",
        "zerotrust.creations.list",
      ].includes(path),
    ),
  ).toBe(true);
});

test("an invalidated asynchronous policy result cannot restore old menu rights", async () => {
  const data = await fixture(),
    context = new AbortController(),
    service = createContentAccess(data.client, () => context.signal);
  const release = deferred(),
    entered = deferred(),
    original = data.client.query;
  let held = true;
  data.client.query = async (path, input) => {
    const result = await original(path, input);
    if (path === "zerotrust.policy.get" && held) {
      held = false;
      entered.resolve();
      await release.promise;
    }
    return result;
  };
  try {
    const stale = service.read().then(
      () => false,
      () => true,
    );
    await entered.promise;
    data.set(
      await data.sign([rule("catalog:products", "procurement", ["read"])]),
    );
    service.refresh();
    expect((await service.read()).role("view:productPriceRecords")).toBe(true);
    release.resolve();
    expect(await stale).toBe(true);
    expect((await service.read()).role("view:productVendors")).toBe(false);
  } finally {
    release.resolve();
    service.close();
  }
});

test("a substituted session identifier cannot select a different identity's signed grants", async () => {
  const data = await fixture(),
    original = data.client.query;
  data.client.query = (path, input) =>
    path === "auth.sessionInfo"
      ? Promise.resolve([
          { user: { id: "2", username: "owner" }, roles: [":admin"] },
          null,
        ])
      : original(path, input);
  await expect(
    readMenuAccess(data.client, new AbortController().signal),
  ).rejects.toThrow();
});

test("cached projections cannot cross account replacement even before an explicit refresh", async () => {
  const data = await fixture(),
    context = new AbortController(),
    service = createContentAccess(data.client, () => context.signal);
  try {
    expect((await service.read()).role("view:productVendors")).toBe(true);
    const other = await createIdentity(),
      exportKey = base64(crypto.getRandomValues(new Uint8Array(64)));
    await acceptVault(
      exportKey,
      await createAccountVault(exportKey, "test", "different", other, {}),
      false,
    );
    await expect(service.read()).rejects.toThrow();
  } finally {
    service.close();
  }
});

test("one report module never grants other report modules, project access, files or commercial workflows", () => {
  for (const [module, role, kind] of [
    ["delivery-notes", "deliveryNotes", "delivery-note"],
    ["daily-reports", "dailyProjectReports", "daily-report"],
    ["regie-reports", "regieReports", "regie-report"],
  ]) {
    const access = project([
      rule(`project:4:${module}`, "master-data", [...ACTIONS]),
    ]);
    expect(access.role(`manage:${role}`)).toBe(true);
    expect(access.canCreate(kind)).toBe(true);
    for (const other of [
      "deliveryNotes",
      "dailyProjectReports",
      "regieReports",
      "projects",
    ].filter((other) => other !== role))
      for (const action of ["view", "manage", "delete"])
        expect(access.role(`${action}:${other}`)).toBe(false);
    expect(access.canAny("project", "master-data", "read")).toBe(false);
    expect(access.can("project:4", "attachment", "read")).toBe(false);
    expect(access.canSeeOffers()).toBe(false);
  }
});

test("assistant navigation requires its own signed write access and never grants catalogue prices", () => {
  const personal = rule("assistant:user:1", "master-data", [...ACTIONS]);
  const member = project([personal]);
  expect(protectedMenuRole(":llm")).toBe(true);
  expect(member.role(":llm")).toBe(true);
  expect(member.role("view:products")).toBe(false);
  expect(member.role("view:productPriceRecords")).toBe(false);
  expect(
    project([rule("assistant:user:1", "master-data", ["read"])]).role(":llm"),
  ).toBe(false);
  expect(
    project([
      personal,
      rule("assistant:user:1", "master-data", ["update"], "deny"),
    ]).role(":llm"),
  ).toBe(false);
  expect(
    project([rule("assistant:user:3", "master-data", [...ACTIONS])]).role(
      ":llm",
    ),
  ).toBe(false);
});
