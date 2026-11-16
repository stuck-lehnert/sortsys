import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { createFixtureServer } from "./browser-support.mjs";

let browser;
let server;
before(async () => {
  server = await createFixtureServer();
  try {
    browser = await chromium.launch();
  } catch (error) {
    await server.close();
    server = undefined;
    throw error;
  }
});
after(async () => {
  try {
    await browser?.close();
  } finally {
    await server?.close();
  }
});

async function open(options) {
  const context = await browser.newContext();
  const external = [];
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === server.origin)
      return route.continue();
    external.push(route.request().url());
    return route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  try {
    await page.goto(`${server.origin}/crypto.html`);
    await page.waitForFunction(() => window.cryptoFixture);
    await page.evaluate(
      (options) => window.cryptoFixture.showRemarks(options),
      options,
    );
    return { context, page, external };
  } catch (error) {
    await context.close();
    throw error;
  }
}

const sourceBody = "Freigabe vor Materialbestellung 691837";
async function verifyPrivateTransport(page, secrets) {
  const calls = await page.evaluate(() =>
    window.cryptoFixture.remarkWireCalls(),
  );
  assert.equal(
    calls.some((call) => call.path.startsWith("remarks.")),
    false,
  );
  const wire = JSON.stringify(calls);
  for (const secret of [sourceBody, ...secrets])
    assert.equal(wire.includes(secret), false);
}

for (const [resourceType, locale, theme] of [
  ["project", "de", "light"],
  ["customer", "en", "dark"],
  ["tool", "de", "dark"],
  ["contact", "en", "light"],
]) {
  test(`encrypted ${resourceType} remarks remain readable in ${locale} ${theme}`, async () => {
    const { context, page, external } = await open({
      resourceType,
      locale,
      theme,
    });
    try {
      await page.getByText(sourceBody, { exact: true }).waitFor();
      await page
        .getByRole("heading", {
          name: locale === "de" ? "Vermerke" : "Notes",
          exact: true,
        })
        .waitFor();
      const accessibility = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      assert.deepEqual(
        accessibility.violations.map(({ id, nodes }) => ({
          id,
          targets: nodes.map((node) => node.target),
        })),
        [],
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      await verifyPrivateTransport(page, []);
      assert.deepEqual(external, []);
    } finally {
      await context.close();
    }
  });
}

test("an empty remark section allows creation without update or delete permission", async () => {
  const { context, page, external } = await open({
    empty: true,
    locale: "en",
    actions: ["read", "create"],
  });
  try {
    await page.getByRole("button", { name: "Note", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: "Create note",
      exact: true,
    });
    await dialog
      .getByRole("textbox", { name: "Note *", exact: true })
      .fill("Private new note 782643");
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByText("Private new note 782643", { exact: true }).waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Note actions", exact: true })
        .count(),
      0,
    );
    await verifyPrivateTransport(page, ["782643"]);
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});

test("remark editing does not expose creation or deletion controls", async () => {
  const { context, page } = await open({
    locale: "en",
    actions: ["read", "update"],
  });
  try {
    await page.getByText(sourceBody, { exact: true }).waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Note", exact: true }).count(),
      0,
    );
    await page
      .getByRole("button", { name: "Note actions", exact: true })
      .click();
    assert.equal(
      await page.getByRole("menuitem", { name: "Delete", exact: true }).count(),
      0,
    );
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Edit note", exact: true });
    const field = dialog.getByRole("textbox", { name: "Note *", exact: true });
    await field.fill("Private changed note 882643");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page
      .getByText("Private changed note 882643", { exact: true })
      .waitFor();
    assert.equal(await page.getByText(sourceBody, { exact: true }).count(), 0);
    await verifyPrivateTransport(page, ["882643"]);
  } finally {
    await context.close();
  }
});

test("remark deletion keeps the confirmation while withholding edit and create actions", async () => {
  const { context, page } = await open({
    locale: "en",
    actions: ["read", "delete"],
  });
  try {
    await page.getByText(sourceBody, { exact: true }).waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Note", exact: true }).count(),
      0,
    );
    await page
      .getByRole("button", { name: "Note actions", exact: true })
      .click();
    assert.equal(
      await page.getByRole("menuitem", { name: "Edit", exact: true }).count(),
      0,
    );
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: "Delete note",
      exact: true,
    });
    const confirmation = dialog.getByRole("checkbox");
    await confirmation.focus();
    await confirmation.press("Space");
    assert.equal(await confirmation.isChecked(), true);
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page
      .getByText(sourceBody, { exact: true })
      .waitFor({ state: "hidden" });
    await verifyPrivateTransport(page, []);
  } finally {
    await context.close();
  }
});

test("read-only remark viewers receive no mutation controls", async () => {
  const { context, page } = await open({ locale: "en", actions: ["read"] });
  try {
    await page.getByText(sourceBody, { exact: true }).waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Note", exact: true }).count(),
      0,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Note actions", exact: true })
        .count(),
      0,
    );
    await verifyPrivateTransport(page, []);
  } finally {
    await context.close();
  }
});
