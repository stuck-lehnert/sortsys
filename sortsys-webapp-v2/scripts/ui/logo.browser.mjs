import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { createFixtureServer, webappDirectory } from "./browser-support.mjs";

let browser;
let server;
before(async () => {
  server = await createFixtureServer();
  try {
    browser = await chromium.launch();
  } catch (error) {
    await server.close();
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
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (
      url.hostname === "cdn.jsdelivr.net" &&
      url.pathname ===
        "/npm/@myriaddreamin/typst-ts-web-compiler@0.7.0/pkg/typst_ts_web_compiler_bg.wasm"
    ) {
      return route.fulfill({
        contentType: "application/wasm",
        body: await readFile(
          `${webappDirectory}/node_modules/@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm`,
        ),
      });
    }
    if (url.origin === server.origin) {
      if (
        url.pathname.startsWith("/fonts/nimbus-sans-l/") &&
        /^\/fonts\/nimbus-sans-l\/NimbusSanL-(?:Regu|Bold)\.ttf$/.test(
          url.pathname,
        )
      ) {
        return route.fulfill({
          contentType: "font/ttf",
          body: await readFile(`${webappDirectory}/public${url.pathname}`),
        });
      }
      return route.continue();
    }
    if (url.protocol === "blob:") return route.continue();
    external.push(route.request().url());
    return route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  try {
    await page.goto(`${server.origin}/crypto.html`);
    await page.waitForFunction(() => window.cryptoFixture);
    await page.evaluate(
      (options) => window.cryptoFixture.showLogo(options),
      options,
    );
    return { context, page, external };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function image(page, width = 100, height = 40, mime = "image/png") {
  return page.evaluate(
    ({ width, height, mime }) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      context.fillStyle = "#ff0000";
      context.fillRect(0, 0, width / 2, height);
      if (mime === "image/jpeg") {
        context.fillStyle = "#0000ff";
        context.fillRect(width / 2, 0, width / 2, height);
      }
      return canvas.toDataURL(mime).split(",")[1];
    },
    { width, height, mime },
  );
}
async function upload(page, bytes) {
  await page.locator('input[type="file"]').setInputFiles({
    name: "Vertrauliches Logo 479152.png",
    mimeType: "image/png",
    buffer: Buffer.from(bytes, "base64"),
  });
}

for (const [locale, theme] of [
  ["de", "light"],
  ["en", "dark"],
]) {
  test(`organization logo encrypts, displays and clears on lock in ${locale} ${theme}`, async () => {
    const { context, page, external } = await open({ locale, theme });
    try {
      await page
        .getByRole("button", {
          name: locale === "de" ? "Logo hochladen" : "Upload logo",
          exact: true,
        })
        .waitFor();
      await upload(page, await image(page));
      const preview = page.getByRole("img", {
        name: locale === "de" ? "Organisationslogo" : "Organization logo",
        exact: true,
      });
      await preview.waitFor();
      await page.waitForFunction(
        () => document.querySelector("img")?.naturalWidth > 0,
      );
      const source = await preview.getAttribute("src");
      assert.match(source, /^blob:/);
      const state = await page.evaluate(() => window.cryptoFixture.logoState());
      assert.equal(state.value.image.width, 100);
      assert.equal(state.value.image.height, 40);
      assert.equal(state.value.image.mimeType, "image/png");
      assert.equal(
        JSON.stringify(state.calls).includes("Vertrauliches Logo"),
        false,
      );
      assert.equal(
        state.calls.some((call) =>
          call.path.startsWith("settings.tenantLogo."),
        ),
        false,
      );
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
      await page.evaluate(() => window.cryptoFixture.lockLogo());
      await page.waitForFunction(() =>
        [...document.images].every((image) => !image.getAttribute("src")),
      );
      assert.equal(
        await page.evaluate(async (url) => {
          try {
            await fetch(url);
            return true;
          } catch {
            return false;
          }
        }, source),
        false,
      );
      assert.deepEqual(external, []);
    } finally {
      await context.close();
    }
  });
}

test("local image processing applies EXIF orientation, limits dimensions and preserves transparency", async () => {
  const { context, page } = await open();
  try {
    const oversized = await image(page, 4000, 1000);
    const scaled = await page.evaluate(
      (bytes) =>
        window.cryptoFixture.prepareLogo(bytes, "Logo.png", "image/png"),
      oversized,
    );
    assert.equal(scaled.width, 2048);
    assert.equal(scaled.height, 512);
    assert.deepEqual(scaled.samples[0], [255, 0, 0, 255]);
    assert.equal(scaled.samples[1][3], 0);
    const jpeg = Buffer.from(await image(page, 80, 40, "image/jpeg"), "base64");
    const orientation = Buffer.from([
      255, 225, 0, 34, 69, 120, 105, 102, 0, 0, 73, 73, 42, 0, 8, 0, 0, 0, 1, 0,
      18, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const rotated = Buffer.concat([
      jpeg.subarray(0, 2),
      orientation,
      jpeg.subarray(2),
    ]).toString("base64");
    const result = await page.evaluate(
      (bytes) =>
        window.cryptoFixture.prepareLogo(bytes, "Foto.jpg", "image/jpeg"),
      rotated,
    );
    assert.equal(result.width, 40);
    assert.equal(result.height, 80);
    assert.ok(result.samples[2][0] > 240 && result.samples[2][2] < 15);
    assert.ok(result.samples[3][2] > 240 && result.samples[3][0] < 15);
    await assert.rejects(() =>
      page.evaluate(
        (bytes) =>
          window.cryptoFixture.prepareLogo(bytes, "Logo.svg", "image/svg+xml"),
        oversized,
      ),
    );
    await assert.rejects(() =>
      page.evaluate(
        (bytes) =>
          window.cryptoFixture.prepareLogo(
            bytes,
            "Logo.png",
            "image/png",
            true,
          ),
        oversized,
      ),
    );
  } finally {
    await context.close();
  }
});

test("an upload failure keeps the file for an explicit retry and readonly accounts have no upload action", async () => {
  const { context, page } = await open({ fail: true });
  try {
    await upload(page, await image(page));
    const retry = page.getByRole("button", {
      name: "Erneut versuchen",
      exact: true,
    });
    await retry.waitFor();
    assert.equal(
      (await page.evaluate(() => window.cryptoFixture.logoState())).value.image,
      null,
    );
    await page.evaluate(() => window.cryptoFixture.allowLogoSave());
    await retry.click();
    await page.waitForFunction(
      () => document.querySelector("img")?.naturalWidth > 0,
    );
  } finally {
    await context.close();
  }
  const reader = await open({ readonly: true });
  try {
    await reader.page
      .getByText("Noch kein Organisationslogo verfügbar.", { exact: true })
      .waitFor();
    assert.equal(
      await reader.page
        .getByRole("button", { name: "Logo hochladen", exact: true })
        .count(),
      0,
    );
  } finally {
    await reader.context.close();
  }
});

test("the actual Typst renderer embeds the decrypted PNG logo in the printed PDF", async () => {
  const { context, page, external } = await open();
  try {
    await upload(page, await image(page));
    await page.waitForFunction(
      () => document.querySelector("img")?.naturalWidth > 0,
    );
    const printed = await page.evaluate(() => window.cryptoFixture.printLogo());
    assert.ok(printed.images > 0, "The PDF must contain the logo as an image");
    assert.equal(Buffer.from(printed.bytes).subarray(0, 5).toString(), "%PDF-");
    await mkdir("/tmp/sortsys-logo-qa-20261114", { recursive: true });
    await writeFile(
      "/tmp/sortsys-logo-qa-20261114/logo.pdf",
      Buffer.from(printed.bytes),
    );
    await writeFile(
      "/tmp/sortsys-logo-qa-20261114/logo-browser.png",
      Buffer.from(printed.png, "base64"),
    );
    assert.deepEqual(external, []);
  } finally {
    await context.close();
  }
});
