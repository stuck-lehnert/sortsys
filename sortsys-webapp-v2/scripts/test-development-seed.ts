import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createClient } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import {
  seedDevelopmentTenant,
  DEVELOPMENT_DATA_REVISION,
  DEVELOPMENT_PASSWORD,
} from "./development/seed";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { required } from "../app/lib/data/protectedObjects";
import { duckDriver } from "../app/lib/data/testing/duckDriver.mjs";
import { cliGaebProcessor } from "./lib/gaebProcessor";
import { lockCryptoSession, signIn } from "../app/lib/crypto/session";

assert.equal(process.env.SORTSYS_DISPOSABLE_AUTH_TEST, "1");
const [, , output] = process.argv.slice(2);
assert.ok(output);
const endpoints: string[] = JSON.parse(
  process.env.SORTSYS_AUTH_TEST_ENDPOINTS ?? "null",
);
assert.equal(endpoints.length, 2);
for (const endpoint of endpoints)
  assert.equal(new URL(endpoint).hostname, "127.0.0.1");
const options = {
  endpoint: endpoints[0]!,
  tenant: "development-seed",
  directory: join(dirname(output), "development-seed"),
  operatorPassword: "Disposable-development-operator-2026!",
  signal: new AbortController().signal,
  log: console.log,
};
async function exerciseBrowser() {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "node",
      ["scripts/e2e/development.browser.mjs", output],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          SORTSYS_E2E_OPERATOR_PASSWORD: options.operatorPassword,
        },
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Browser E2E failed: ${signal ?? code}`));
    });
  });
}
if (process.env.SORTSYS_NATIVE_BROWSER_REPLAY === "1") {
  assert.equal(process.env.SORTSYS_NATIVE_BROWSER, "1");
  const fixture = JSON.parse(await readFile(output, "utf8"));
  assert.equal(fixture.success, true);
  assert.equal(fixture.seeded, true);
  assert.equal(fixture.tenant, options.tenant);
  console.log(
    "Browserprüfung mit bereits geprüften Seed-Daten; kein erneutes Seeding",
  );
  await exerciseBrowser();
  process.exit(0);
}
const requests: string[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = new Proxy(originalFetch, {
  apply(target, receiver, args) {
    if (typeof args[1]?.body === "string") requests.push(args[1].body);
    return Reflect.apply(target, receiver, args);
  },
});
const owner = createClient(endpoints[1]!, "development-owner-check");
const member = createClient(endpoints[0]!, "development-member-check");
try {
  const progress = await seedDevelopmentTenant(options);
  console.log(
    "Beispielkonten sind eingerichtet; Geschäftsvorgänge werden geprüft",
  );
  assert.equal(progress.complete, true);
  assert.equal(progress.dataRevision, DEVELOPMENT_DATA_REVISION);
  await signIn(owner, {
    tenant: options.tenant,
    username: "john.doe",
    password: DEVELOPMENT_PASSWORD,
  });
  assert.ok(
    (await required(owner.query("auth.sessionInfo", undefined))).roles.includes(
      ":admin",
    ),
  );
  const business = createBusinessClient(owner, {
    productDriver: duckDriver,
    gaebProcessor: cliGaebProcessor,
  });
  let cases = 0;
  let products = 0;
  try {
    const matches = await required(
      business.query("products.list", { search: "Haftvermittler" }),
    );
    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.name, "Haftgrund");
    const offers = await required(business.query("commercial.cases.list", {}));
    console.log(`${offers.length} Geschäftsvorgänge geladen`);
    cases = offers.length;
    assert.ok(cases >= 45);
    const expectedStatuses = {
      offer: ["draft", "sent", "accepted", "rejected", "cancelled"],
      variation: ["draft", "sent", "accepted", "rejected", "cancelled"],
      alternative: ["draft", "sent", "accepted", "rejected", "cancelled"],
      measurement: ["draft", "submitted", "approved", "cancelled"],
      subcontract: ["draft", "requested", "awarded", "confirmed", "cancelled"],
      procurement: ["draft", "requested", "awarded", "confirmed", "cancelled"],
      calculation: ["draft", "approved", "cancelled"],
      invoice: ["draft", "sent", "partially_paid", "paid", "cancelled"],
      progress_invoice: [
        "draft",
        "sent",
        "partially_paid",
        "paid",
        "cancelled",
      ],
      final_invoice: ["draft", "sent"],
    };
    for (const [kind, statuses] of Object.entries(expectedStatuses)) {
      const actual = new Set(
        offers
          .filter((value) => value.kind === kind)
          .map((value) => value.status),
      );
      assert.deepEqual(
        actual,
        new Set(statuses),
        `${kind}: sample workflow phases`,
      );
    }
    assert.ok(
      offers.some(
        (value) =>
          value.status === "accepted" &&
          value.projectId === progress.ids.project,
      ),
    );
    const files = await required(
      business.query("projects.files.list", {
        projectId: progress.ids.project!,
      }),
    );
    assert.equal(files.length, 7);
    const takeoffId = progress.ids["measurement-approved"]!;
    const takeoff = await required(
      business.query("commercial.cases.get", { id: takeoffId }),
    );
    assert.equal(takeoff.case.parentCaseId, progress.ids.contract);
    const takeoffDocument = takeoff.documents.find(
      (value) => value.phase === "31",
    );
    assert.ok(takeoffDocument);
    const measured = await required(
      business.query("commercial.documents.get", {
        caseId: takeoffId,
        id: takeoffDocument.id,
      }),
    );
    assert.equal(measured.canEdit, false);
    assert.ok((measured.xml.match(/sortsys:measure:v1:/g)?.length ?? 0) >= 20);
    assert.ok(measured.xml.includes("sortsys:takeoff-heading:v1:"));
    assert.equal(measured.xml.includes("·"), false);
    const allPhases = new Set<string>();
    const numbers = new Set<string>();
    for (const [index, offer] of offers.entries()) {
      const entry = await required(
        business.query("commercial.cases.get", { id: offer.id }),
      );
      for (const document of entry.documents) allPhases.add(document.phase);
      if (entry.invoice?.invoiceNumber) {
        assert.equal(
          numbers.has(entry.invoice.invoiceNumber),
          false,
          "Invoice numbers must be unique",
        );
        numbers.add(entry.invoice.invoiceNumber);
      }
      if ((index + 1) % 10 === 0)
        console.log(`${index + 1}/${offers.length} Vorgangsdetails geprüft`);
    }
    assert.deepEqual(
      allPhases,
      new Set([
        "31",
        "52",
        "83",
        "84",
        "85",
        "86",
        "87",
        "89",
        "93",
        "94",
        "96",
        "97",
      ]),
    );
    const final = await required(
      business.query("commercial.cases.get", {
        id: progress.ids["final-sent"]!,
      }),
    );
    const chain = await required(
      business.query("commercial.invoices.context", {
        contractCaseId: progress.ids.contract!,
      }),
    );
    assert.equal(chain.progressInvoices.length, 2);
    const deducted = chain.progressInvoices.reduce(
      (sum, value) => sum + Math.round(Number(value.netAmount) * 100),
      0,
    );
    assert.equal(
      Math.round(Number(final.invoice!.deductedNet) * 100),
      deducted,
    );
    products = (await required(business.query("products.list", {}))).length;
    await required(
      business.mutate("products.update", {
        id: progress.ids["product-0"]!,
        data: { name: "Haftgrund, manuell angepasst" },
      }),
    );
  } finally {
    business.dispose();
  }
  await signIn(member, {
    tenant: options.tenant,
    username: "frank.doe",
    password: DEVELOPMENT_PASSWORD,
  });
  console.log(
    "Sichtbarkeit und verweigerte Zugriffe des normalen Kontos werden geprüft",
  );
  assert.ok(
    !(
      await required(member.query("auth.sessionInfo", undefined))
    ).roles.includes(":admin"),
  );
  const restricted = createBusinessClient(member, {
    productDriver: duckDriver,
  });
  try {
    const [result, error] = await restricted.query("products.list", {});
    if (error) assert.ok(error.cause instanceof InvalidProtectedData);
    else assert.deepEqual(result, []);
    const [, denied] = await restricted.mutate("products.create", {
      customId: 999990,
      name: "Darf nicht angelegt werden",
      baseUnit: "Stk",
    });
    assert.ok(denied instanceof InvalidProtectedData);
    for (const key of [
      "measurement-approved",
      "subcontract-confirmed",
      "procurement-confirmed",
      "final-sent",
    ]) {
      const [entry, denied] = await restricted.query("commercial.cases.get", {
        id: progress.ids[key]!,
      });
      assert.equal(entry, null);
      assert.ok(denied, `Frank must not see ${key}`);
    }
  } finally {
    restricted.dispose();
  }
  console.log(
    "Wiederholtes Seeding und Erhalt manueller Änderungen werden geprüft",
  );
  const { exerciseNativeToolResponsibility } =
    await import("./test-native-tool-responsibility");
  await exerciseNativeToolResponsibility(owner, member);
  await seedDevelopmentTenant({ ...options, endpoint: endpoints[1]! });
  await signIn(owner, {
    tenant: options.tenant,
    username: "john.doe",
    password: DEVELOPMENT_PASSWORD,
  });
  const reopened = createBusinessClient(owner, { productDriver: duckDriver });
  try {
    assert.equal(
      (await required(reopened.query("commercial.cases.list", {}))).length,
      cases,
    );
    assert.equal(
      (await required(reopened.query("products.list", {}))).length,
      products,
    );
    assert.equal(
      (
        await required(
          reopened.query("products.list", { search: "manuell angepasst" }),
        )
      )[0]?.name,
      "Haftgrund, manuell angepasst",
    );
  } finally {
    reopened.dispose();
  }
  const wire = requests.join("\n");
  for (const marker of [
    "Musterbau & Ausbau",
    "Fenstersanierung Pirckheimer",
    "Haftvermittler",
    "manuell angepasst",
    "Private automatic tool responsibility 672914",
    "Unangemeldet",
  ])
    assert.equal(wire.includes(marker), false, marker);
  await writeFile(
    output,
    JSON.stringify({
      success: true,
      seeded: true,
      tenant: options.tenant,
      projectId: progress.ids.project,
      caseId: progress.ids.contract,
      measurementCaseId: progress.ids["measurement-approved"],
      procurementCaseId: progress.ids["procurement-confirmed"],
      finalInvoiceCaseId: progress.ids["final-sent"],
    }),
  );
  console.log(
    "Development seed verified: ready admin/member, all commercial phases, measured positions, invoice settlement, unique numbers, encrypted files, denied access and idempotent restart.",
  );
  if (process.env.SORTSYS_NATIVE_BROWSER === "1") {
    await exerciseBrowser();
  }
} finally {
  globalThis.fetch = originalFetch;
  await lockCryptoSession();
}
