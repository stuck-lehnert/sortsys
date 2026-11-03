import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { chromium } from "playwright";
import { waitForFocus } from "./browser-support.mjs";

let browser;
let page;

before(async () => {
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
});

beforeEach(async () => {
  page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await page.setContent(
    '<button id="trigger">Trigger</button><button id="other">Other</button>',
  );
});

afterEach(async () => {
  await page?.close();
});

test("focus waiting observes restoration on a later animation frame", async () => {
  const trigger = page.locator("#trigger");
  await page.locator("#other").focus();
  const restored = waitForFocus(page, trigger);

  await page.evaluate(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.getElementById("trigger").focus();
      });
    });
  });
  await restored;

  assert.equal(
    await trigger.evaluate((element) => element === document.activeElement),
    true,
  );
});

test("focus waiting fails when a different element keeps focus", async () => {
  page.setDefaultTimeout(150);
  await page.locator("#other").focus();

  await assert.rejects(waitForFocus(page, page.locator("#trigger")), {
    name: "TimeoutError",
  });
  assert.equal(
    await page
      .locator("#other")
      .evaluate((element) => element === document.activeElement),
    true,
  );
});
