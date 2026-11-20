import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createClient, type Client, type MutateInput } from "@sortsys/v2-client";
import { initializeTenant } from "../app/lib/crypto/initializeTenant";
import { changeAreaActionAccesses, changeCreationAccesses } from "../app/lib/crypto/permissions";
import { lockCryptoSession, signIn } from "../app/lib/crypto/session";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { newProductRowId, publicId } from "../app/lib/data/products";
import { projectCollection } from "../app/lib/data/projectData";
import { toolUsageCollection } from "../app/lib/data/projectToolUsage";
import { required } from "../app/lib/data/protectedObjects";
import { duckDriver } from "../app/lib/data/testing/duckDriver.mjs";
import { toolCollection } from "../app/lib/data/toolData";
import { enrollToolResponsibleMember } from "./test-native-tool-recovery";

assert.equal(process.env.SORTSYS_DISPOSABLE_AUTH_TEST, "1");
const tenant = "deferred-tool-rates-tenant";
assert.equal(process.env.SORTSYS_NATIVE_AUTH_TENANT, tenant);
const endpoints: unknown = JSON.parse(process.env.SORTSYS_AUTH_TEST_ENDPOINTS ?? "null");
assert.ok(Array.isArray(endpoints) && endpoints.length === 2);
for (const endpoint of endpoints) {
  const url = new URL(endpoint);
  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.ok(url.port);
}
const report = process.argv[4];
assert.ok(report);
const signal = new AbortController().signal;
const fresh = { strategy: "network-only" } as const;
const owner = createClient(endpoints[0], "rate-administrator");
const member = createClient(endpoints[1], "rate-booker");
const ownerLogin = {
  tenant,
  username: "builder",
  password: "Only-owner-knows-this-password-2026!",
};
const memberLogin = {
  tenant,
  username: "werkzeug.ausgabe",
  password: "Disposable-tool-rate-booker-2026!",
};

async function business<T>(
  transport: Client,
  work: (client: ReturnType<typeof createBusinessClient>) => Promise<T>,
) {
  const client = createBusinessClient(transport, { productDriver: duckDriver });
  try {
    return await work(client);
  } finally {
    client.dispose();
  }
}

async function checkBrowser(project: string, tool: string) {
  await new Promise<void>((resolve, reject) => {
    const browser = spawn("node", ["scripts/e2e/deferredToolRates.browser.mjs"], {
      stdio: "inherit",
      env: {
        ...process.env,
        SORTSYS_RATE_PROJECT: project,
        SORTSYS_RATE_TOOL: tool,
        SORTSYS_RATE_OWNER: ownerLogin.username,
        SORTSYS_RATE_OWNER_PASSWORD: ownerLogin.password,
        SORTSYS_RATE_MEMBER: memberLogin.username,
        SORTSYS_RATE_MEMBER_PASSWORD: memberLogin.password,
      },
    });
    browser.once("error", reject);
    browser.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Tool rate browser failed with ${signal ?? code}`));
    });
  });
}

try {
  await signIn(owner, ownerLogin);
  await initializeTenant(owner, signal, duckDriver);
  const { project, tool, person } = await business(owner, async (client) => ({
    project: await required(client.mutate("projects.create", { title: "Werkzeugkosten Nordflügel" })),
    tool: await required(client.mutate("tools.create", {
      customId: await required(client.query("tools.suggestNextCustomId", undefined)),
      brand: "Nordflügel",
      category: "Bohrhammer",
      label: "Ausgabe mit getrennten Berechtigungen",
      purchasePrice: 7671.125,
      usageCostPerDay: 14.125,
    })),
    person: await required(client.mutate("users.create", {
      username: memberLogin.username,
      firstName: "Werkzeug",
      lastName: "Ausgabe",
      email: null,
      phone: null,
      costPerHour: 0,
      vacationDaysPerYear: 28,
      contractType: "internal",
      supervisorUserId: null,
    })),
  }));
  await enrollToolResponsibleMember(
    owner,
    member,
    { id: person.id, username: memberLogin.username },
    ownerLogin,
    memberLogin.password,
  );
  await signIn(owner, ownerLogin);
  const subject = `user:${person.id}`;
  await changeCreationAccesses(owner, subject, { "tool-tracking": true }, signal);
  await changeAreaActionAccesses(owner, subject, [
    { area: projectCollection(project.id), patch: { read: true } },
    { area: toolCollection("tool", tool.id, "master-data"), patch: { read: true, update: true } },
    { area: toolUsageCollection(project.id, "master-data"), patch: { read: true, create: true, update: true } },
  ], signal);

  await signIn(member, memberLogin);
  const [source] = await required(member.query(
    "zerotrust.toolRates.references", { tools: [tool.id] }, fresh,
  ));
  assert.ok(source);
  const tracking = publicId(newProductRowId());
  const command: MutateInput<"tools.trackMany"> = {
    operationId: tracking,
    tools: [{ id: tool.id, expectedTrackingId: null }],
    data: { projectId: project.id, responsibleUserId: person.id },
  };
  let tampered = false;
  const altered: Client = {
    ...member,
    mutate: (async (path, input, options) => {
      if (path === "zerotrust.objects.batch" && !tampered) {
        const changed = structuredClone(input as MutateInput<"zerotrust.objects.batch">);
        const packet = changed.objects.find(({ toolRate }) => toolRate);
        if (packet?.toolRate) {
          packet.toolRate.reference = "f".repeat(64);
          tampered = true;
          return member.mutate("zerotrust.objects.batch", changed, options);
        }
      }
      return member.mutate(path, input, options);
    }) as Client["mutate"],
  };
  await business(altered, async (client) => {
    const [, failed] = await client.mutate("tools.trackMany", command);
    assert.ok(tampered && failed);
    assert.equal((await required(client.query("tools.get", { id: tool.id }, fresh))).available, true);
  });
  await business(member, async (client) => {
    const booking = await required(client.mutate("tools.trackMany", command));
    assert.equal(booking.trackings[0]?.trackingId, tracking);
    const [, denied] = await member.query(
      "zerotrust.toolRates.historical",
      { tool: tool.id, tracking, reference: source.reference },
      fresh,
    );
    assert.equal(denied?.code, "FORBIDDEN");
  });
  console.log("A delegated shipment succeeded and a mismatched price pointer was rejected.");

  await signIn(owner, ownerLogin);
  await business(owner, async (client) => {
    const before = await required(client.query("projects.costs.overview", {}, fresh));
    const row = before.find(({ projectId }) => projectId === project.id);
    assert.ok(row?.accessError);
    assert.equal(row.costs, null);
    await required(client.mutate("tools.update", {
      id: tool.id, data: { usageCostPerDay: 32.75 },
    }));
  });

  await signIn(member, memberLogin);
  await business(member, async (client) => {
    const request = await required(client.mutate("tools.trackings.transfers.request", {
      toolTrackingId: tracking,
      transferToUserId: person.id,
      projectId: project.id,
    }));
    await required(client.mutate("tools.trackings.transfers.accept", {
      id: request.id,
      projectId: project.id,
    }));
  });
  console.log("The delegated user accepted a transfer after the first price changed.");

  await signIn(owner, ownerLogin);
  await business(owner, async (client) => {
    await required(client.mutate("tools.update", {
      id: tool.id, data: { usageCostPerDay: 103.25 },
    }));
    const [, wrongBooking] = await owner.query(
      "zerotrust.toolRates.historical",
      { tool: tool.id, tracking: publicId(newProductRowId()), reference: source.reference },
      fresh,
    );
    assert.equal(wrongBooking?.code, "NOT_FOUND");
    if (process.env.SORTSYS_NATIVE_BROWSER === "1") {
      await checkBrowser(project.id, tool.id);
    }
    const costs = await required(client.query("projects.costs.get", { projectId: project.id }, fresh));
    const rates = costs.toolTrackings.map(({ toolUsageCostPerDay }) => toolUsageCostPerDay);
    assert.deepEqual(rates.sort(), [14.125, 32.75]);
    const after = await required(client.query("projects.costs.overview", {}, fresh));
    const row = after.find(({ projectId }) => projectId === project.id);
    assert.equal(row?.accessError, null);
    assert.equal(row.costs, costs.totalCosts.overall);
  });

  await signIn(member, memberLogin);
  await business(member, async (client) => {
    const bookings = await required(client.query("tools.trackings.list", { toolId: tool.id }, fresh));
    assert.equal(bookings.length, 2);
    assert.ok(bookings.every(({ toolUsageCostPerDay }) => toolUsageCostPerDay === null));
    const [, denied] = await member.query(
      "zerotrust.objects.get",
      { id: toolUsageCollection(project.id, "procurement").prefix + tracking },
      fresh,
    );
    assert.equal(denied?.code, "FORBIDDEN");
  });
  console.log("The project charged the two original rates and the booker still had no price access.");
  await writeFile(report, JSON.stringify({ success: true, separateAccounts: true, exactRates: true }));
} finally {
  owner.setToken(null);
  member.setToken(null);
  lockCryptoSession();
}
