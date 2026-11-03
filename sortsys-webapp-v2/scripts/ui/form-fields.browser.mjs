import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright";
import { createFixtureServer, waitForFocus } from "./browser-support.mjs";

let browser;
let server;
let context;
let page;
let errors;

before(async () => {
  server = await createFixtureServer();
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await server?.close();
});

beforeEach(async () => {
  context = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
  });
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === server.origin) {
      return route.continue();
    }

    return route.abort("blockedbyclient");
  });
  page = await context.newPage();
  page.setDefaultTimeout(5000);
  errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      errors.push(message.text());
    }
  });
});

afterEach(async () => {
  await context?.close();
  assert.deepEqual(
    errors,
    [],
    "Form controls must not emit runtime warnings or errors",
  );
});

async function openFields(locale = "en", theme = "light") {
  await page.goto(`${server.origin}/controls?locale=${locale}&theme=${theme}`);
  await page
    .getByRole("heading", { name: "HeroUI workflow fixtures" })
    .waitFor();
  await page.evaluate(() => document.fonts.ready);
}

async function assertActive(locator) {
  assert.equal(
    await locator.evaluate((node) => node === document.activeElement),
    true,
  );
}

for (const width of [320, 355, 375, 414]) {
  for (const theme of ["light", "dark"]) {
    test(`adjacent form fields fit without stacking at ${width}px in ${theme}`, async () => {
      await page.setViewportSize({ width, height: 879 });
      await openFields(width === 355 ? "de" : "en", theme);
      await page
        .getByRole("button", { name: "Open field dialog", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Field dialog",
        exact: true,
      });
      await dialog.waitFor();
      await page.waitForFunction(
        () => !document.querySelector("[data-entering]"),
      );

      for (const id of [
        "native-date-row",
        "picker-row",
        "mixed-field-row",
        "autocomplete-row",
      ]) {
        const row = dialog.getByTestId(id);
        const layout = await row.evaluate((node) => {
          const bounds = node.getBoundingClientRect();
          return {
            left: bounds.left,
            right: bounds.right,
            width: bounds.width,
            scrollWidth: node.scrollWidth,
            fields: [...node.children]
              .filter((field) => {
                return field.getBoundingClientRect().width > 0;
              })
              .map((field) => {
                const rect = field.getBoundingClientRect();
                return {
                  left: rect.left,
                  right: rect.right,
                  top: rect.top,
                  width: rect.width,
                };
              }),
            controls: [
              ...node.querySelectorAll("input:not([type=hidden]), button"),
            ].map((control) => {
              const rect = control.getBoundingClientRect();
              return { left: rect.left, right: rect.right };
            }),
          };
        });
        const detail = `${id}: ${JSON.stringify(layout)}`;
        assert.ok(layout.left >= 0 && layout.right <= width, detail);
        assert.ok(layout.scrollWidth <= layout.width + 1, detail);
        assert.equal(layout.fields.length, 2, detail);
        assert.ok(
          Math.abs(layout.fields[0].top - layout.fields[1].top) <= 1,
          detail,
        );
        assert.ok(layout.fields[0].right <= layout.fields[1].left + 1, detail);

        for (const field of [...layout.fields, ...layout.controls]) {
          assert.ok(
            field.left >= layout.left - 1 && field.right <= layout.right + 1,
            detail,
          );
        }
      }

      await dialog.getByLabel("From", { exact: true }).fill("2026-10-30");
      await dialog.getByLabel("To", { exact: true }).fill("2026-11-02");
      assert.equal(
        await dialog.getByLabel("From", { exact: true }).inputValue(),
        "2026-10-30",
      );
      const date = dialog.getByLabel("Start date", { exact: true });
      await date.fill("2026-11-03");
      assert.equal(
        await dialog.getByLabel("End date", { exact: true }).inputValue(),
        "2026-11-03",
      );
      const results = await new AxeBuilder({ page })
        .include("[role=dialog]")
        .analyze();
      assert.deepEqual(results.violations, []);
    });
  }
}

test("dialog fields wait for deliberate Tab or click and retain keyboard dismissal", async () => {
  await openFields();
  const trigger = page.getByRole("button", {
    name: "Open field dialog",
    exact: true,
  });
  await trigger.click();
  const dialog = page.getByRole("dialog", {
    name: "Field dialog",
    exact: true,
  });
  await dialog.waitFor();
  await page.waitForFunction(() => !document.querySelector("[data-entering]"));
  await assertActive(dialog);
  await page.keyboard.press("Tab");
  await assertActive(dialog.getByLabel("First dialog field", { exact: true }));
  await page.keyboard.press("Shift+Tab");
  const close = dialog.getByRole("button", {
    name: "Close field dialog",
    exact: true,
  });
  await assertActive(close);
  await page.keyboard.press("Tab");
  await assertActive(dialog.getByLabel("First dialog field", { exact: true }));
  await dialog.getByRole("spinbutton", { name: "Hours", exact: true }).click();
  await assertActive(
    dialog.getByRole("spinbutton", { name: "Hours", exact: true }),
  );
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await waitForFocus(page, trigger);

  await trigger.click();
  await dialog.waitFor();
  await page.waitForFunction(() => !document.querySelector("[data-entering]"));
  await page.keyboard.press("Shift+Tab");
  await assertActive(close);
  await page.keyboard.press("Enter");
  await dialog.waitFor({ state: "hidden" });
  await waitForFocus(page, trigger);
});

test("asynchronous dialog fields do not steal focus and page autofocus still works", async () => {
  await openFields();
  await page
    .getByRole("button", { name: "Open delayed fields", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Delayed field dialog",
    exact: true,
  });
  await dialog.waitFor();
  await page.waitForFunction(() => !document.querySelector("[data-entering]"));
  await assertActive(dialog);
  const input = dialog.getByLabel("Loaded dialog field", { exact: true });
  await input.waitFor();
  await assertActive(dialog);
  await page.keyboard.press("Tab");
  await assertActive(input);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await page
    .getByRole("button", { name: "Show page field", exact: true })
    .click();
  await assertActive(page.getByLabel("Page autofocus", { exact: true }));
});
