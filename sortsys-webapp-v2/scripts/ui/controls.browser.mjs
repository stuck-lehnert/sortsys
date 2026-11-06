import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright";
import {
  createFixtureServer,
  fixtureDirectory,
  readState,
  waitForFocus,
  waitForState,
} from "./browser-support.mjs";

let browser;
let server;
let context;
let page;
let errors;

before(async () => {
  server = await createFixtureServer();
  browser = await chromium.launch();
  await mkdir(join(fixtureDirectory, "screenshots"), { recursive: true });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

beforeEach(async () => {
  context = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
    timezoneId: "Europe/Berlin",
    serviceWorkers: "block",
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
    "The actual UI must not produce browser errors or warnings.",
  );
});

async function openFixture({
  locale = "en",
  theme = "light",
  screen = "controls",
} = {}) {
  const query = new URLSearchParams({ locale, theme, screen });
  await page.goto(`${server.origin}/controls?${query}`);
  await page
    .getByRole("heading", {
      name:
        screen === "shell" ? "Navigation fixture" : "HeroUI workflow fixtures",
    })
    .waitFor();
  await page.waitForFunction(
    (locale) => document.documentElement.lang === locale,
    locale,
  );
  await page.evaluate(() => document.fonts.ready);
}

async function assertNoPageOverflow() {
  const sizes = await page.evaluate(() => ({
    content: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  assert.ok(sizes.content <= sizes.viewport + 1, JSON.stringify(sizes));
}

test("actual fields preserve checkbox, empty-select, Unicode and date-array contracts", async () => {
  await openFixture();
  await page.getByText("Enabled", { exact: true }).click();
  await waitForState(page, "Field values", (value) => value.enabled === true);

  const provider = page.getByRole("button", { name: /Provider/ });
  await provider.click();
  assert.equal(
    await page
      .getByRole("option", { name: "Disabled provider" })
      .getAttribute("aria-disabled"),
    "true",
  );
  await page.getByRole("option", { name: "Beta", exact: true }).click();
  await waitForState(page, "Field values", (value) => value.choice === "beta");
  await provider.click();
  await page
    .getByRole("option", { name: "Choose provider", exact: true })
    .click();
  await waitForState(page, "Field values", (value) => value.choice === "");

  const single = page.getByRole("combobox", { name: "Single selection" });
  await single.fill("Müll");
  await page.getByRole("option", { name: "Müller", exact: true }).click();
  await waitForState(
    page,
    "Field values",
    (value) => value.single === "mueller",
  );

  const date = page.getByLabel("Date", { exact: true });
  await date.fill("2026-10-17");
  await waitForState(
    page,
    "Field values",
    (value) => value.dates?.length === 1,
  );
  assert.equal(await date.inputValue(), "2026-10-17");
  await date.fill("");
  await waitForState(page, "Field values", (value) => value.dates === null);
});

test("multiselect filters, supports keyboard choice, creates once and clears controlled values", async () => {
  await openFixture();
  const multiple = page.getByRole("combobox", { name: "Multiple selection" });
  await multiple.fill("Bet");
  await page.getByRole("option", { name: "Beta", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("option", { name: "Alpha", exact: true }).count(),
    0,
  );
  await multiple.press("ArrowDown");
  await multiple.press("Enter");
  await waitForState(
    page,
    "Field values",
    (value) => value.multiple.join() === "beta",
  );

  await multiple.fill("New contact");
  await page
    .getByRole("option", { name: "Create New contact", exact: true })
    .click();
  await waitForState(
    page,
    "Field values",
    (value) =>
      value.multiple.filter((id) => id === "created-New contact").length === 1,
  );
  await multiple.press("Escape");
  await page.waitForFunction(() => {
    const input = document.querySelector(
      'input[role="combobox"][aria-expanded="true"]',
    );
    return !input;
  });
  await page
    .getByRole("button", { name: "Clear selection", exact: true })
    .click();
  await waitForState(
    page,
    "Field values",
    (value) => value.multiple.length === 0,
  );
});

test("forms focus invalid fields, prevent duplicate submissions and retain values after errors", async () => {
  await openFixture();
  const save = page.getByRole("button", { name: "Save form", exact: true });
  const name = page.getByRole("textbox", { name: "Name *", exact: true });
  await save.click();
  assert.equal(
    await name.evaluate((input) => document.activeElement === input),
    true,
  );
  assert.equal((await readState(page, "Submission state")).submissions, 0);

  await name.fill("Retained name");
  await save.evaluate((button) => {
    button.click();
    button.click();
  });
  await waitForState(
    page,
    "Submission state",
    (value) => value.values?.name === "Retained name",
  );
  assert.equal((await readState(page, "Submission state")).submissions, 1);

  await page.getByRole("button", { name: "Fail saving", exact: true }).click();
  await save.click();
  const error = page
    .getByRole("alert")
    .filter({ hasText: "Synthetic save failed. Please retry." });
  await error.waitFor();
  assert.equal(
    await error.evaluate((element) => document.activeElement === element),
    true,
  );
  assert.equal(await name.inputValue(), "Retained name");
  await page.getByRole("button", { name: "Allow saving", exact: true }).click();
  await save.click();
  await waitForState(
    page,
    "Submission state",
    (value) => value.submissions === 3,
  );
});

test("dropdowns handle keyboard focus, permissions, selected states and deliberate icons", async () => {
  await openFixture();
  const trigger = page.getByRole("button", {
    name: "File actions",
    exact: true,
  });
  await trigger.focus();
  await trigger.press("ArrowDown");
  const menu = page.getByRole("menu", { name: "File actions", exact: true });
  await menu.waitFor();
  assert.equal(await trigger.getAttribute("aria-expanded"), "true");
  assert.equal(
    await menu.getByText("Hidden action", { exact: true }).count(),
    0,
  );
  assert.equal(
    await menu
      .getByRole("menuitem", { name: "Disabled action" })
      .getAttribute("aria-disabled"),
    "true",
  );
  assert.equal(
    await menu
      .getByRole("menuitem", { name: "Rename", exact: true })
      .locator("[data-fixture-icon]")
      .count(),
    0,
  );
  assert.equal(
    await menu
      .getByRole("menuitem", { name: "Excel", exact: true })
      .locator("[data-fixture-icon]")
      .count(),
    1,
  );

  await page.waitForFunction(
    () => document.activeElement?.getAttribute("role") === "menuitem",
  );
  await page.keyboard.press("d");
  await page.waitForFunction(
    () => document.activeElement?.textContent.trim() === "Delete",
  );
  assert.equal(
    await page
      .getByRole("menuitem", { name: "Delete", exact: true })
      .evaluate((element) => document.activeElement === element),
    true,
  );
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("aria-label") === "File actions",
  );
  assert.equal(
    await trigger.evaluate((element) => document.activeElement === element),
    true,
  );

  await trigger.click();
  const selected = page.getByRole("menuitemcheckbox", {
    name: "Show archived",
    exact: true,
  });
  assert.equal(await selected.getAttribute("aria-checked"), "true");
  await selected.click();
  await waitForState(page, "Menu state", (value) => value.selected === false);
  await trigger.click();
  assert.equal(
    await page
      .getByRole("menuitemcheckbox", { name: "Show archived", exact: true })
      .getAttribute("aria-checked"),
    "false",
  );
});

test("nested dialogs trap and restore focus and submit only the topmost non-composing form", async () => {
  await openFixture();
  const trigger = page.getByRole("button", {
    name: "Open dialog",
    exact: true,
  });
  await trigger.click();
  const parent = page.getByRole("dialog", {
    name: "Parent dialog",
    exact: true,
  });
  await parent.waitFor();
  const parentText = parent.getByLabel("Parent text", { exact: true });
  await parentText.press("Enter");
  assert.equal(
    await page.getByLabel("Dialog confirmations").textContent(),
    "1",
  );

  const nestedTrigger = parent.getByRole("button", {
    name: "Open nested dialog",
    exact: true,
  });
  await nestedTrigger.focus();
  await nestedTrigger.press("Enter");
  const nested = page.getByRole("dialog", {
    name: "Nested dialog",
    exact: true,
  });
  await nested.waitFor();
  assert.equal(
    await page.getByLabel("Dialog confirmations").textContent(),
    "1",
  );
  const nestedText = nested.getByLabel("Nested text", { exact: true });
  await nestedText.press("Enter");
  assert.equal(
    await page.getByLabel("Dialog confirmations").textContent(),
    "11",
  );
  await nestedText.dispatchEvent("keydown", {
    key: "Enter",
    isComposing: true,
  });
  await nestedText.dispatchEvent("keydown", { key: "Enter", repeat: true });
  assert.equal(
    await page.getByLabel("Dialog confirmations").textContent(),
    "11",
  );

  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press("Tab");
    assert.equal(
      await nested.evaluate((dialog) =>
        dialog.contains(document.activeElement),
      ),
      true,
    );
  }

  await page.keyboard.press("Escape");
  await nested.waitFor({ state: "hidden" });
  await waitForFocus(page, nestedTrigger);
  await page.keyboard.press("Escape");
  await parent.waitFor({ state: "hidden" });
  await waitForFocus(page, trigger);
});

test("nested dialogs recover a focus attempt blocked by inert teardown", async () => {
  await openFixture();
  await page.getByRole("button", { name: "Open dialog", exact: true }).click();
  const parent = page.getByRole("dialog", {
    name: "Parent dialog",
    exact: true,
  });
  const trigger = parent.getByRole("button", {
    name: "Open nested dialog",
    exact: true,
  });
  const opener = await trigger.elementHandle();
  await trigger.click();
  const nested = page.getByRole("dialog", {
    name: "Nested dialog",
    exact: true,
  });
  await nested.getByLabel("Nested text", { exact: true }).focus();

  await opener.evaluate((opener) => {
    const focus = opener.focus;

    // Exercise the browser's real inert rejection independently of frame timing.
    opener.focus = function (...argumentsList) {
      opener.focus = focus;
      const wasInert = opener.inert;
      opener.inert = true;

      try {
        focus.apply(opener, argumentsList);
        window.inertBlockedRestoration =
          document.activeElement === document.body;
      } finally {
        opener.inert = wasInert;
      }
    };
  });
  await opener.dispose();

  await page.keyboard.press("Escape");
  await nested.waitFor({ state: "hidden" });
  await waitForFocus(page, trigger);
  assert.equal(await page.evaluate(() => window.inertBlockedRestoration), true);
  assert.equal(await parent.isVisible(), true);
});

test("dialog teardown preserves a deliberate subsequent focus change", async () => {
  await openFixture();
  await page.getByRole("button", { name: "Open dialog", exact: true }).click();
  const parent = page.getByRole("dialog", {
    name: "Parent dialog",
    exact: true,
  });
  const trigger = parent.getByRole("button", {
    name: "Open nested dialog",
    exact: true,
  });
  const parentText = parent.getByLabel("Parent text", { exact: true });
  const opener = await trigger.elementHandle();
  await trigger.click();
  const nested = page.getByRole("dialog", {
    name: "Nested dialog",
    exact: true,
  });
  await nested.getByLabel("Nested text", { exact: true }).focus();

  await opener.evaluate((opener) => {
    opener.addEventListener(
      "focus",
      () => {
        opener.closest("[role='dialog']").querySelector("input").focus();
      },
      { once: true },
    );
  });
  await opener.dispose();

  await page.keyboard.press("Escape");
  await nested.waitFor({ state: "hidden" });
  await waitForFocus(page, parentText);
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }),
  );
  assert.equal(
    await parentText.evaluate((input) => document.activeElement === input),
    true,
  );
});

test("full-size document dialogs retain a usable editor viewport", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFixture();
  await page
    .getByRole("button", { name: "Open full-size dialog", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Full-size document",
    exact: true,
  });
  const bounds = await dialog.boundingBox();
  assert.ok(
    bounds.width >= 350 && bounds.height >= 760,
    JSON.stringify(bounds),
  );
  const editor = await page.getByTestId("editor-area").boundingBox();
  assert.ok(editor.height >= 600, JSON.stringify(editor));
  await assertNoPageOverflow();
});

test("tables preserve three-state sorting, row actions and asynchronous states", async () => {
  await openFixture();
  const table = page.getByRole("region", { name: "Data table", exact: true });
  const sort = table.getByRole("columnheader", { name: /Name/ });
  await sort.click();
  await page.waitForFunction(
    () =>
      atob(new URLSearchParams(window.location.search).get("sortfixture")) ===
      '[0,"ASC"]',
  );
  await sort.click();
  await page.waitForFunction(
    () =>
      atob(new URLSearchParams(window.location.search).get("sortfixture")) ===
      '[0,"DESC"]',
  );
  await sort.click();
  await page.waitForFunction(
    () => !new URLSearchParams(window.location.search).has("sortfixture"),
  );
  await table.getByRole("row").filter({ hasText: "Alpha" }).click();
  await waitForState(page, "Table state", (value) => value.opened === "1");

  await table.getByRole("button", { name: "loading", exact: true }).click();
  await table.locator(".ss-loading[role='status']").waitFor();
  await table.getByRole("button", { name: "empty", exact: true }).click();
  await table.getByText("No entries available.", { exact: true }).waitFor();
  await table.getByRole("button", { name: "error", exact: true }).click();
  await table
    .getByRole("alert")
    .filter({ hasText: "Entries could not be loaded." })
    .waitFor();
});

test("toast actions, updates, programmatic dismissal and unmount have stable lifecycles", async () => {
  await openFixture();
  await page
    .getByRole("button", { name: "Add persistent", exact: true })
    .click();
  await page.getByText("Notification 1", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Update latest", exact: true })
    .click();
  await page.getByText("Updated notification", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Dismiss latest", exact: true })
    .click();
  await waitForState(
    page,
    "Notification state",
    (value) => value.dismissals.length === 1,
  );
  assert.equal(
    (await readState(page, "Notification state")).dismissals[0].reason,
    "programmatic",
  );

  await page.getByRole("button", { name: "Add action", exact: true }).click();
  await page.getByRole("button", { name: "Apply action", exact: true }).click();
  await waitForState(
    page,
    "Notification state",
    (value) => value.dismissals.length === 2,
  );
  const state = await readState(page, "Notification state");
  assert.equal(state.actionCount, 1);
  assert.equal(state.dismissals[1].reason, "action");

  await page.getByRole("button", { name: "Add timed", exact: true }).click();
  await page.getByText("Notification 3", { exact: true }).waitFor();
  await page.evaluate(() => window.__uiUnmount());
  await page.waitForTimeout(1700);
  assert.equal((await page.evaluate(() => window.__uiEvents)).length, 2);
});

test("toast timeout pauses on hover unless explicitly disabled", async () => {
  await openFixture();
  await page.getByRole("button", { name: "Add timed", exact: true }).click();
  const title = page.getByText("Notification 1", { exact: true });
  await title.hover();
  await page.waitForTimeout(1700);
  assert.equal(await title.isVisible(), true);
  await page.mouse.move(0, 0);
  await title.waitFor({ state: "hidden" });
  await waitForState(
    page,
    "Notification state",
    (value) => value.dismissals.length === 1,
  );
  assert.equal(
    (await readState(page, "Notification state")).dismissals[0].reason,
    "timeout",
  );

  await page.getByRole("button", { name: "Add unpaused", exact: true }).click();
  const unpaused = page.getByText("Notification 2", { exact: true });
  await unpaused.hover();
  await unpaused.waitFor({ state: "hidden" });
  await waitForState(
    page,
    "Notification state",
    (value) => value.dismissals.length === 2,
  );
});

test("desktop navigation exposes location, groups and a working skip target", async () => {
  await openFixture({ screen: "shell" });
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await page.getByRole("link", { name: "All projects", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('output[aria-label="Current location"]')
        ?.textContent === "/projects",
  );
  assert.equal(
    await page.getByLabel("Current location").textContent(),
    "/projects",
  );
  const skip = page.getByRole("link", { name: "Skip to content", exact: true });
  await skip.focus();
  await skip.press("Enter");
  assert.equal(
    await page
      .locator("main")
      .evaluate((main) => document.activeElement === main),
    true,
  );
  await assertNoPageOverflow();
});

test("mobile navigation traps focus, closes after routing and restores its trigger", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFixture({ screen: "shell" });
  const trigger = page.getByRole("button", {
    name: "Main navigation",
    exact: true,
  });
  await trigger.click();
  const dialog = page.getByRole("dialog", {
    name: "Main navigation",
    exact: true,
  });
  await dialog.waitFor();
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press("Tab");
    assert.equal(
      await dialog.evaluate((element) =>
        element.contains(document.activeElement),
      ),
      true,
    );
  }

  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await page.waitForFunction(
    (id) => document.activeElement?.id === id,
    await trigger.getAttribute("id"),
  );
  assert.equal(
    await trigger.evaluate((element) => document.activeElement === element),
    true,
  );
  await trigger.click();
  await dialog.getByRole("button", { name: "Projects", exact: true }).click();
  await dialog.getByRole("link", { name: "All projects", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.waitForFunction(
    () =>
      document.querySelector('output[aria-label="Current location"]')
        ?.textContent === "/projects",
  );
  assert.equal(
    await page.getByLabel("Current location").textContent(),
    "/projects",
  );
  await assertNoPageOverflow();
});

for (const locale of ["de", "en"]) {
  for (const theme of ["light", "dark"]) {
    for (const [layout, width, height] of [
      ["desktop", 1400, 1000],
      ["mobile", 390, 844],
    ]) {
      test(`${locale} ${theme} ${layout}: real production CSS, reflow and WCAG checks`, async () => {
        await page.setViewportSize({ width, height });
        await openFixture({ locale, theme });
        await assertNoPageOverflow();
        const results = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
          .analyze();
        assert.deepEqual(results.violations, []);
        await page.screenshot({
          path: join(
            fixtureDirectory,
            "screenshots",
            `${locale}-${theme}-${layout}.png`,
          ),
          fullPage: true,
        });
      });
    }
  }
}

test("200% text sizing reflows and reduced motion disables the product loading animation", async () => {
  await openFixture();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await assertNoPageOverflow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page
    .getByRole("region", { name: "Data table", exact: true })
    .getByRole("button", { name: "loading", exact: true })
    .click();
  await page.locator(".ss-spinner").waitFor();
  assert.equal(
    await page
      .locator(".ss-spinner")
      .evaluate(
        (spinner) => getComputedStyle(spinner, "::before").animationName,
      ),
    "none",
  );
});

test("only opted-in document editors are edge-to-edge with a compact context header", async () => {
  for (const viewport of [
    { width: 1400, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await openFixture();
    await page
      .getByRole("button", { name: "Open editor dialog", exact: true })
      .click();
    const editor = page.getByRole("dialog", {
      name: "Projects.xlsx",
      exact: true,
    });
    await editor.waitFor();
    await page.waitForFunction(() => {
      const dialog = document.querySelector(
        '[data-editor-fullscreen] [data-slot="modal-dialog"]',
      );
      const bounds = dialog?.getBoundingClientRect();
      return (
        bounds &&
        Math.abs(bounds.x) < 1 &&
        Math.abs(bounds.y) < 1 &&
        Math.abs(bounds.width - innerWidth) < 1 &&
        Math.abs(bounds.height - innerHeight) < 1
      );
    });
    const bounds = await editor.boundingBox();
    assert.equal(Math.round(bounds.width), viewport.width);
    assert.equal(Math.round(bounds.height), viewport.height);
    assert.equal(
      await editor.evaluate((element) =>
        parseFloat(getComputedStyle(element).borderRadius),
      ),
      0,
    );
    const header = await editor
      .locator('[data-slot="modal-header"]')
      .boundingBox();
    assert.ok(header.height <= 44, JSON.stringify(header));
    const heading = await editor
      .getByRole("heading", { name: "Projects.xlsx" })
      .boundingBox();
    assert.ok(
      Math.abs(heading.x + heading.width / 2 - viewport.width / 2) <= 1,
      JSON.stringify({ heading, viewport }),
    );
    const close = editor.getByRole("button", {
      name: "Close editor",
      exact: true,
    });
    const closeBounds = await close.boundingBox();
    assert.ok(
      Math.abs(
        closeBounds.y + closeBounds.height / 2 - header.y - header.height / 2,
      ) <= 1,
      JSON.stringify({ header, closeBounds }),
    );
    assert.ok(
      viewport.width - closeBounds.x - closeBounds.width <= 5,
      JSON.stringify(closeBounds),
    );
    assert.ok(
      closeBounds.y >= header.y &&
        closeBounds.y + closeBounds.height <= header.y + header.height,
      JSON.stringify({ header, closeBounds }),
    );
    assert.ok(
      closeBounds.height <= 36 && closeBounds.width <= 36,
      JSON.stringify(closeBounds),
    );
    assert.ok(
      (await close.evaluate((element) =>
        parseFloat(getComputedStyle(element).borderRadius),
      )) >=
        closeBounds.width / 2,
    );
    await close.focus();
    assert.ok(
      (await close.evaluate((element) =>
        parseFloat(getComputedStyle(element).outlineOffset),
      )) <= 0,
    );
    const frame = await page
      .getByTitle("Edge-to-edge editor", { exact: true })
      .boundingBox();
    assert.equal(Math.round(frame.width), viewport.width);
    assert.ok(frame.height >= viewport.height - 64, JSON.stringify(frame));
    await page.keyboard.press("Escape");
    await editor.waitFor({ state: "hidden" });

    await page
      .getByRole("button", { name: "Open full-size dialog", exact: true })
      .click();
    const ordinary = page.getByRole("dialog", {
      name: "Full-size document",
      exact: true,
    });
    await ordinary.waitFor();
    await ordinary.evaluate(async (element) => {
      const animations = [];
      for (let current = element; current; current = current.parentElement) {
        animations.push(...current.getAnimations());
        if (current.dataset.slot === "modal-backdrop") {
          break;
        }
      }

      await Promise.all(animations.map((animation) => animation.finished));
    });
    const inset = await ordinary.boundingBox();
    assert.ok(inset.x > 0 && inset.y > 0, JSON.stringify(inset));
    assert.ok(
      inset.width < viewport.width && inset.height < viewport.height,
      JSON.stringify(inset),
    );
    assert.ok(
      (await ordinary.evaluate((element) =>
        parseFloat(getComputedStyle(element).borderRadius),
      )) > 0,
    );
    await page.keyboard.press("Escape");
    await ordinary.waitFor({ state: "hidden" });
  }
});

test("expandables preserve uncontrolled form values while collapsed", async () => {
  await openFixture();
  const section = page.getByRole("region", {
    name: "Expandable section",
    exact: true,
  });
  const trigger = section.getByRole("button", {
    name: "Additional details",
    exact: true,
  });
  await trigger.click();
  const field = section.getByRole("textbox", {
    name: "Retained detail",
    exact: true,
  });
  await field.fill("Müller – retained detail");
  await trigger.click();
  await field.waitFor({ state: "hidden" });
  await trigger.click();
  assert.equal(await field.inputValue(), "Müller – retained detail");
  assert.equal(await trigger.getAttribute("aria-expanded"), "true");
});

test("white modal surfaces have distinct secondary fields and create options are emphasized", async () => {
  await openFixture();
  await page.getByRole("button", { name: "Open dialog", exact: true }).click();
  const field = page.getByRole("textbox", { name: "Parent text", exact: true });
  const colors = await field.evaluate((element) => {
    const dialog = element.closest('[data-slot="modal-dialog"]');
    return {
      field: getComputedStyle(element).backgroundColor,
      surface: getComputedStyle(dialog).backgroundColor,
    };
  });
  assert.notEqual(colors.field, "rgba(0, 0, 0, 0)", JSON.stringify(colors));
  assert.notEqual(colors.field, colors.surface, JSON.stringify(colors));
  await page.keyboard.press("Escape");
  await page
    .getByRole("combobox", { name: "Multiple selection", exact: true })
    .fill("New item");
  const create = page.getByRole("option", {
    name: "Create New item",
    exact: true,
  });
  await create.waitFor();
  const style = await create.evaluate((element) => ({
    weight: Number(getComputedStyle(element).fontWeight),
    background: getComputedStyle(element).backgroundColor,
    icon: Boolean(element.querySelector('svg[aria-hidden="true"]')),
  }));
  assert.ok(style.weight >= 500, JSON.stringify(style));
  assert.notEqual(style.background, "rgba(0, 0, 0, 0)", JSON.stringify(style));
  assert.equal(style.icon, true);
});

test("table headers remain compact without uppercase labels", async () => {
  await openFixture();
  const headers = page.getByRole("columnheader");
  assert.ok((await headers.count()) >= 2);
  for (const header of await headers.all()) {
    const bounds = await header.boundingBox();
    assert.ok(bounds.height <= 48, JSON.stringify(bounds));
    assert.equal(
      await header.evaluate(
        (element) => getComputedStyle(element).textTransform,
      ),
      "none",
    );
  }
});

test("mobile navigation is a full-height left drawer with compact pill links and a white main area", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFixture({ screen: "shell" });
  assert.equal(
    await page
      .locator("main")
      .evaluate((element) => getComputedStyle(element).backgroundColor),
    "rgb(255, 255, 255)",
  );
  await page
    .getByRole("button", { name: "Main navigation", exact: true })
    .click();
  const drawer = page.getByRole("dialog", {
    name: "Main navigation",
    exact: true,
  });
  await drawer.waitFor();
  await page.waitForFunction(() => {
    const dialog = document.querySelector('[data-slot="drawer-dialog"]');
    const bounds = dialog?.getBoundingClientRect();
    return (
      bounds &&
      Math.abs(bounds.x) < 1 &&
      Math.abs(bounds.y) < 1 &&
      bounds.height >= innerHeight - 1
    );
  });
  const bounds = await drawer.boundingBox();
  assert.ok(bounds.width <= 342, JSON.stringify(bounds));
  for (const item of [
    drawer.getByRole("link", { name: "Home", exact: true }),
    drawer.getByRole("button", { name: "Projects", exact: true }),
  ]) {
    const geometry = await item.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        height: element.getBoundingClientRect().height,
        radius: parseFloat(style.borderRadius),
        padding: parseFloat(style.paddingTop),
      };
    });
    assert.ok(
      geometry.height >= 44 && geometry.height <= 48,
      JSON.stringify(geometry),
    );
    assert.ok(geometry.radius >= geometry.height / 2, JSON.stringify(geometry));
    assert.ok(geometry.padding <= 8, JSON.stringify(geometry));
  }
});

async function settleDialog(dialog) {
  await dialog.evaluate(async (element) => {
    const animations = [];
    for (let current = element; current; current = current.parentElement) {
      animations.push(...current.getAnimations());
      if (current.dataset.slot === "modal-backdrop") {
        break;
      }
    }

    await Promise.all(animations.map((animation) => animation.finished));
  });
}

test("actual form provider keeps fewer than four fields compact and enlarges larger forms", async () => {
  for (const viewport of [
    { width: 1400, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await openFixture();

    for (const count of [2, 3, 4]) {
      await page
        .getByRole("button", { name: `Open ${count}-field form`, exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: `${count}-field form`,
        exact: true,
      });
      await dialog.waitFor();
      await page.waitForFunction(
        ({ count }) => {
          const backdrop = [...document.querySelectorAll(".ss-modal")].at(-1);
          return Boolean(backdrop?.dataset.fullheight) === count >= 4;
        },
        { count },
      );
      await settleDialog(dialog);
      const bounds = await dialog.boundingBox();
      assert.ok(bounds.x > 0 && bounds.y > 0, JSON.stringify(bounds));
      assert.ok(bounds.width < viewport.width, JSON.stringify(bounds));
      assert.ok(
        count >= 4
          ? bounds.height >= viewport.height - 80
          : bounds.height < viewport.height - 100,
        JSON.stringify(bounds),
      );
      assert.equal(await dialog.locator("input").count(), count);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
    }

    await page
      .getByRole("button", { name: "Open 3-field form", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "3-field form",
      exact: true,
    });
    await dialog
      .getByRole("textbox", { name: "Field 1", exact: true })
      .fill("Preserved value");
    await dialog
      .getByRole("button", { name: "Add extra field", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll(".ss-modal")].at(-1)?.dataset
          .fullheight === "true",
    );
    assert.equal(
      await dialog
        .getByRole("textbox", { name: "Field 1", exact: true })
        .inputValue(),
      "Preserved value",
    );
    await dialog
      .getByRole("button", { name: "Remove extra field", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        ![...document.querySelectorAll(".ss-modal")].at(-1)?.dataset.fullheight,
    );
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
  }
});

test("compact attributes and expandable affordances remain visible", async () => {
  await openFixture();
  const term = page.getByText("Attribute label", { exact: true });
  const label = await term.boundingBox();
  const value = await page
    .getByText("Attribute value", { exact: true })
    .boundingBox();
  assert.ok(
    value.y - label.y - label.height <= 3,
    JSON.stringify({ label, value }),
  );
  const trigger = page.getByRole("button", {
    name: "Additional details",
    exact: true,
  });
  const style = await trigger.evaluate((element) => ({
    cursor: getComputedStyle(element).cursor,
    radius: parseFloat(getComputedStyle(element).borderRadius),
    border: parseFloat(getComputedStyle(element).borderTopWidth),
  }));
  assert.equal(style.cursor, "pointer");
  assert.ok(style.radius >= 8, JSON.stringify(style));
  assert.ok(style.border >= 1, JSON.stringify(style));
});

test("text links stay blue and soften to seventy percent on hover", async () => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await openFixture({ locale: "en", theme: "light", screen: "shell" });
  const link = page.getByRole("link", { name: "Content link", exact: true });
  assert.equal(
    await link.evaluate((element) => getComputedStyle(element).color),
    "rgb(0, 95, 204)",
  );
  await link.hover();
  assert.equal(
    await link.evaluate((element) => getComputedStyle(element).opacity),
    "0.7",
  );
  await page.mouse.move(1, 1);
  assert.equal(
    await link.evaluate((element) => getComputedStyle(element).opacity),
    "1",
  );
});

test("actual async single suggestions show pending status and appear while typing", async () => {
  await openFixture();
  const region = page.getByRole("region", {
    name: "Async autocomplete",
    exact: true,
  });
  const input = region.getByRole("combobox", {
    name: "Async single",
    exact: true,
  });
  await region
    .getByRole("button", {
      name: "Remove Existing contact",
      exact: true,
    })
    .waitFor();
  await input.fill("fresh");
  const root = region.locator(".ss-combobox");
  // React Aria hides the field's siblings from AT while its popover is open.
  // Keep the visual cube in the field and announce pending results in the popover.
  await root.locator('[role="status"]').waitFor();
  await page
    .getByRole("listbox")
    .getByRole("status", {
      name: "Loading suggestions …",
      exact: true,
    })
    .waitFor();
  assert.equal(await input.getAttribute("aria-expanded"), "true");
  const option = page.getByRole("option", {
    name: "Fresh result",
    exact: true,
  });
  await option.waitFor();
  assert.equal(await option.count(), 1);
  await input.press("ArrowDown");
  await input.press("Enter");
  await page.waitForFunction(
    () => document.querySelector('[name="single"]').value === "Fresh result",
  );
  assert.equal(await input.inputValue(), "Fresh result");

  await input.fill("failure");
  await page
    .getByText("Suggestions could not be loaded.", { exact: true })
    .waitFor();
  assert.equal(await root.getByRole("status").count(), 0);
});

test("preselected async multiselect uses unique removable chips and separate action slots", async () => {
  for (const viewport of [
    { width: 1400, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await openFixture();
    const region = page.getByRole("region", {
      name: "Async autocomplete",
      exact: true,
    });
    const input = region.getByRole("combobox", {
      name: "Async people",
      exact: true,
    });
    const remove = region.getByRole("button", {
      name: "Remove Existing contact",
      exact: true,
    });
    await remove.waitFor();
    assert.equal(await remove.count(), 1);
    const chip = remove.locator("..");
    const style = await chip.evaluate((element) => ({
      radius: parseFloat(getComputedStyle(element).borderRadius),
      height: element.getBoundingClientRect().height,
    }));
    assert.ok(style.radius >= style.height / 2, JSON.stringify(style));

    // Focus a visible field, as a pointer user does after scrolling on mobile.
    await input.scrollIntoViewIfNeeded();
    await input.click();
    await input.fill("alpha");
    const root = region.locator(".ss-multi-select");
    const pending = root.locator('[role="status"]');
    await pending.waitFor();
    await page.getByRole("listbox").waitFor();
    assert.equal(await input.getAttribute("aria-expanded"), "true");
    const clear = root.locator('button[aria-label="Clear async selection"]');
    assert.equal(await clear.innerText(), "");
    const clearBounds = await clear.boundingBox();
    const arrowBounds = await root.locator(".combo-box__trigger").boundingBox();
    const loadingBounds = await pending.boundingBox();
    assert.ok(
      loadingBounds.x + loadingBounds.width <= clearBounds.x + 1,
      JSON.stringify({ loadingBounds, clearBounds }),
    );
    assert.ok(
      clearBounds.x + clearBounds.width <= arrowBounds.x + 1,
      JSON.stringify({ clearBounds, arrowBounds }),
    );
    const result = page.getByRole("option", {
      name: "Alpha contact",
      exact: true,
    });
    await result.waitFor();
    assert.equal(await result.count(), 1);
    await result.click();
    await input.press("Escape");
    await region
      .getByRole("button", { name: "Remove Alpha contact", exact: true })
      .waitFor();
    await remove.click();
    assert.equal(await remove.count(), 0);
    await clear.click();
    assert.equal(await region.locator("[data-slot='tag']").count(), 0);
    assert.equal(await input.inputValue(), "");
    await assertNoPageOverflow();
  }
});

test("async suggestions reject stale results and keep Escape dismissal while a request finishes", async () => {
  await openFixture();
  const input = page.getByRole("combobox", {
    name: "Async single",
    exact: true,
  });
  await input.fill("slow");
  await page.waitForFunction(() =>
    window.__sortsysAutocompleteRequests?.some(
      (request) => request.query === "slow" && !request.finished,
    ),
  );
  await input.fill("fresh");
  await page
    .getByRole("option", { name: "Fresh result", exact: true })
    .waitFor();
  await page.waitForFunction(() =>
    window.__sortsysAutocompleteRequests?.some(
      (request) => request.query === "slow" && request.finished,
    ),
  );
  assert.equal(
    await page
      .getByRole("option", { name: "Slow stale result", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("option", { name: "Fresh result", exact: true })
      .count(),
    1,
  );

  await input.fill("alpha");
  await page.waitForFunction(() =>
    window.__sortsysAutocompleteRequests?.some(
      (request) => request.query === "alpha" && !request.finished,
    ),
  );
  await input.press("Escape");
  assert.equal(await input.getAttribute("aria-expanded"), "false");
  await page.waitForFunction(() =>
    window.__sortsysAutocompleteRequests?.some(
      (request) => request.query === "alpha" && request.finished,
    ),
  );
  assert.equal(await input.getAttribute("aria-expanded"), "false");
  assert.equal(await page.getByRole("listbox").count(), 0);
});

for (const [layout, viewport] of [
  ["desktop", { width: 1400, height: 1000 }],
  ["mobile", { width: 390, height: 844 }],
]) {
  test(`load-more tables append rows and retain focus on ${layout}`, async () => {
    await page.setViewportSize(viewport);
    await openFixture();
    const region = page.getByRole("region", {
      name: "Progressive table",
      exact: true,
    });
    const entries = region.getByText(/^Entry \d\d$/);
    assert.equal(await entries.count(), 3);
    assert.equal(await region.getByRole("combobox").count(), 0);
    assert.equal(await region.getByRole("navigation").count(), 0);

    const more = region.getByRole("button", { name: "Show more", exact: true });
    const target = await more.getAttribute("aria-controls");
    assert.equal(await page.locator(`[id="${target}"]`).count(), 1);
    await more.click();
    assert.equal(await entries.count(), 6);
    assert.deepEqual(await entries.allTextContents(), [
      "Entry 01",
      "Entry 02",
      "Entry 03",
      "Entry 04",
      "Entry 05",
      "Entry 06",
    ]);
    await more.focus();
    await more.press("Enter");
    assert.equal(await entries.count(), 7);
    const complete = region.getByRole("button", {
      name: "All entries shown",
      exact: true,
    });
    assert.equal(await complete.getAttribute("aria-disabled"), "true");
    assert.equal(
      await complete.evaluate((element) => document.activeElement === element),
      true,
    );
    assert.equal(
      await region.getByRole("status").innerText(),
      "7 of 7 entries",
    );
    await complete.press("Enter");
    assert.equal(await entries.count(), 7);
    await assertNoPageOverflow();
  });
}

test("load-more tables restore the expanded view and reset for filters and sorting", async () => {
  await openFixture();
  const region = page.getByRole("region", {
    name: "Progressive table",
    exact: true,
  });
  const entries = region.getByText(/^Entry \d\d$/);
  const more = region.getByRole("button", { name: "Show more", exact: true });
  await more.click();
  assert.equal(await entries.count(), 6);
  await region
    .getByRole("button", { name: "Refresh rows", exact: true })
    .click();
  assert.equal(await entries.count(), 6);
  await region
    .getByRole("button", { name: "Toggle table", exact: true })
    .click();
  assert.equal(await entries.count(), 0);
  await region
    .getByRole("button", { name: "Toggle table", exact: true })
    .click();
  assert.equal(await entries.count(), 6);
  await region
    .getByRole("button", { name: "Toggle filter", exact: true })
    .click();
  assert.equal(await entries.count(), 2);
  assert.equal(await more.count(), 0);
  await region
    .getByRole("button", { name: "Toggle filter", exact: true })
    .click();
  assert.equal(await entries.count(), 6);
  await region
    .getByRole("columnheader", { name: "Entry", exact: true })
    .click();
  assert.equal(await entries.count(), 3);
  await more.click();
  assert.equal(await entries.count(), 6);
  await region
    .getByRole("columnheader", { name: "Entry", exact: true })
    .click();
  assert.equal(await entries.count(), 3);
  assert.deepEqual(await entries.allTextContents(), [
    "Entry 07",
    "Entry 06",
    "Entry 05",
  ]);
});

async function activeSuggestion(input) {
  return input.evaluate((node) => {
    const active = node.ownerDocument.getElementById(
      node.getAttribute("aria-activedescendant"),
    );
    return active?.textContent?.trim() ?? null;
  });
}

test("autocomplete results share Tab, Shift-Tab and arrow navigation without changing the value", async () => {
  await openFixture();
  const input = page.getByRole("combobox", {
    name: "Single selection",
    exact: true,
  });
  await input.click();
  await page.getByRole("option", { name: "Alpha", exact: true }).waitFor();
  await input.press("Tab");
  assert.equal(await activeSuggestion(input), "Alpha");
  assert.equal(
    await input.evaluate((node) => node === document.activeElement),
    true,
  );
  await input.press("Tab");
  assert.equal(await activeSuggestion(input), "Beta");
  await input.press("Shift+Tab");
  assert.equal(await activeSuggestion(input), "Alpha");
  await input.press("ArrowDown");
  assert.equal(await activeSuggestion(input), "Beta");
  assert.equal((await readState(page, "Field values")).single, null);
  await input.press("Enter");
  await waitForState(page, "Field values", (value) => value.single === "beta");
});

test("multiselect results include the create action in Tab order and leave at the boundary", async () => {
  await openFixture();
  const input = page.getByRole("combobox", {
    name: "Multiple selection",
    exact: true,
  });
  await input.click();
  const options = page.getByRole("option");
  await options.first().waitFor();
  const labels = (await options.allTextContents()).map((text) => text.trim());
  for (const label of labels) {
    await input.press("Tab");
    assert.equal(await activeSuggestion(input), label);
  }
  assert.equal((await readState(page, "Field values")).multiple.length, 0);
  await input.press("Tab");
  assert.equal(
    await input.evaluate((node) => node === document.activeElement),
    false,
  );
  assert.equal((await readState(page, "Field values")).multiple.length, 0);
  await input.click();
  await input.press("Shift+Tab");
  assert.equal(await activeSuggestion(input), labels.at(-1));
  await input.press("Shift+Tab");
  assert.equal(await activeSuggestion(input), labels.at(-2));
  await input.press("Enter");
  await waitForState(
    page,
    "Field values",
    (value) => value.multiple.length === 1,
  );
});

test("autocomplete Tab leaves empty results and Escape returns to normal form tabbing", async () => {
  await openFixture();
  const input = page.getByRole("combobox", {
    name: "Single selection",
    exact: true,
    includeHidden: true,
  });
  const next = page.getByRole("combobox", {
    name: "Multiple selection",
    exact: true,
  });
  await input.fill("No matching result");
  await input.press("Tab");
  assert.equal(
    await input.evaluate((node) => node === document.activeElement),
    false,
  );
  assert.equal((await readState(page, "Field values")).single, null);
  await input.fill("");
  await page.getByRole("option", { name: "Alpha", exact: true }).waitFor();
  await input.press("Tab");
  await input.press("Escape");
  await input.press("Tab");
  assert.equal(
    await next.evaluate((node) => node === document.activeElement),
    true,
  );
});

test("Tab skips disabled suggestions, scrolls active results and leaves without selecting", async () => {
  await openFixture({ screen: "long" });
  const input = page.getByRole("combobox", {
    name: "Long choices",
    exact: true,
  });
  await input.scrollIntoViewIfNeeded();
  await input.click();
  await input.fill("Result");
  await page.waitForFunction(
    (node) => node.getAttribute("aria-expanded") === "true",
    await input.elementHandle(),
  );
  await page.getByRole("option", { name: "Result 01", exact: true }).waitFor();
  await input.press("Tab");
  assert.equal(await activeSuggestion(input), "Result 01");
  await input.press("Tab");
  assert.equal(await activeSuggestion(input), "Result 03");
  for (let index = 3; index < 40; index++) await input.press("Tab");
  assert.equal(await activeSuggestion(input), "Result 40");
  const option = page.getByRole("option", { name: "Result 40", exact: true });
  const bounds = await option.boundingBox();
  const list = await page.getByRole("listbox").boundingBox();
  assert.ok(
    bounds.y >= list.y - 1 &&
      bounds.y + bounds.height <= list.y + list.height + 1,
    "The active suggestion scrolls into the listbox viewport",
  );
  await input.press("Tab");
  const next = page.getByRole("textbox", {
    name: "After long choices",
    exact: true,
  });
  assert.equal(
    await next.evaluate((node) => node === document.activeElement),
    true,
  );
  assert.equal(
    await page.getByLabel("Long choice state").textContent(),
    "none",
  );
  await input.click();
  await input.fill("Result ");
  await page.waitForFunction(
    (node) => node.getAttribute("aria-expanded") === "true",
    await input.elementHandle(),
  );
  await input.press("Tab");
  await input.press("Shift+Tab");
  const previous = page.getByRole("button", {
    name: "Before long choices",
    exact: true,
  });
  assert.equal(
    await previous.evaluate((node) => node === document.activeElement),
    true,
  );
});

for (const theme of ["light", "dark"])
  test(`all notice variants and floating notifications have a visible surface and accessible contrast in ${theme}`, async () => {
    await openFixture({ theme, screen: "notices" });
    const notices = page.getByTestId("notices");
    await notices.getByText("info notice", { exact: true }).waitFor();
    assert.equal(await notices.locator(".ss-notice").count(), 4);
    const colors = await notices.locator(".ss-notice").evaluateAll((nodes) =>
      nodes.map((node) => {
        const style = getComputedStyle(node);
        return {
          background: style.backgroundColor,
          border: style.borderLeftColor,
          fg: getComputedStyle(node.querySelector('[data-slot="alert-title"]'))
            .color,
        };
      }),
    );
    for (const color of colors) {
      assert.notEqual(color.background, "rgba(0, 0, 0, 0)");
      assert.notEqual(color.fg, color.background);
      assert.notEqual(color.border, color.background);
    }
    await page
      .getByRole("button", { name: "Show warning notification", exact: true })
      .click();
    await page.getByText("Warning notification", { exact: true }).waitFor();
    const accessibility = await new AxeBuilder({ page })
      .withTags(["wcag2aa", "wcag21aa"])
      .analyze();
    assert.deepEqual(
      accessibility.violations.map(({ id, nodes }) => ({
        id,
        elements: nodes.map(({ target, failureSummary }) => ({
          target,
          failureSummary,
        })),
      })),
      [],
    );
    await assertNoPageOverflow();
    await page.screenshot({
      path: join(fixtureDirectory, "screenshots", `notices-${theme}.png`),
      fullPage: true,
    });
  });
