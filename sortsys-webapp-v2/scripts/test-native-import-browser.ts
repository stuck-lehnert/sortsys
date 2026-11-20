import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { expect } from "playwright/test";
import { applicationServer } from "./e2e/applicationServer.mjs";

const completedFile = "Lieferschein aus dem laufenden Tab.pdf";
const interruptedFile = "Lieferschein vor dem Neuladen.pdf";

type ProviderMessage = {
  content:
    | string
    | null
    | { type: string; file?: { filename: string; file_data: string } }[];
};

export async function browserImportFixture() {
  const original = await readFile(
    new URL("../../sortsys-api-v2/seed-assets/materialfreigabe.pdf", import.meta.url),
  );
  const encoded = `data:application/pdf;base64,${original.toString("base64")}`;
  const release = Promise.withResolvers<void>();
  const received = new Set<string>();
  let interrupted = false;

  return {
    original,
    received: (name: string) => received.has(name),
    interrupted: () => interrupted,
    release: () => release.resolve(),
    async reply(messages: ProviderMessage[]): Promise<Response | undefined> {
      for (const { content } of messages) {
        if (!Array.isArray(content)) continue;
        for (const part of content) {
          const file = part.file;
          if (part.type !== "file" || !file) continue;
          if (file.filename !== completedFile && file.filename !== interruptedFile) {
            continue;
          }

          assert.ok(
            file.file_data === encoded,
            "The model receives the browser's exact PDF bytes",
          );
          received.add(file.filename);
          if (file.filename === completedFile) {
            await release.promise;
            return;
          }
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"choices":['));
              },
              cancel() {
                interrupted = true;
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
      }
    },
  };
}

async function confirmReload(page: Page, confirm: boolean) {
  const warning = page.waitForEvent("dialog");
  const reload = page.reload().catch((error: unknown) => error);
  const dialog = await warning;
  assert.equal(dialog.type(), "beforeunload");
  if (confirm) await dialog.accept();
  else await dialog.dismiss();
  const result = await reload;
  if (confirm && result instanceof Error) throw result;
}

export async function testImportInBrowser(
  endpoint: string,
  credentials: { username: string; password: string },
  fixture: Awaited<ReturnType<typeof browserImportFixture>>,
) {
  assert.equal(process.env.SORTSYS_DISPOSABLE_AUTH_TEST, "1");
  const server = await applicationServer(
    process.env.SORTSYS_E2E_APPLICATION_BUILD ??
      new URL("../build/client", import.meta.url).pathname,
    endpoint,
  );
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({
      executablePath: process.env.SORTSYS_E2E_CHROMIUM,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage({ locale: "de-DE" });
    page.setDefaultTimeout(20_000);
    const check = expect.configure({ timeout: 20_000 });
    let leakedToRpc = false;
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith("/api/v2/")) return;
      const wire = decodeURIComponent(url.href) + (request.postData() ?? "");
      if ([completedFile, interruptedFile, "LIVE-2026-1"].some((text) => wire.includes(text)))
        leakedToRpc = true;
    });

    await page.goto(`${server.origin}/auth/login`);
    await page
      .getByRole("textbox", { name: /^Nutzername/ })
      .fill(credentials.username);
    await page.getByLabel(/^Passwort/).fill(credentials.password);
    await page.getByRole("button", { name: "Anmelden", exact: true }).click();
    await check(
      page.getByRole("link", { name: "Einstellungen", exact: true }),
    ).toBeVisible();
    await page.goto(`${server.origin}/dashboard`);

    const openImport = page
      .getByRole("group", { name: "Arbeit erfassen" })
      .getByRole("button", { name: "Einlesen", exact: true });
    const dialog = page.getByRole("dialog", {
      name: "Dokumente werden eingelesen",
    });
    const scanRow = (name: string) =>
      page.getByRole("button").filter({ hasText: name });
    const completedRow = scanRow(completedFile);
    const selectAndStart = async (name: string) => {
      await page.locator('input[type="file"][multiple]').setInputFiles({
        name,
        mimeType: "application/pdf",
        buffer: fixture.original,
      });
      await page
        .locator(".delivery-scan-start")
        .getByRole("button", { name: "Einlesen", exact: true })
        .click();
      await check(dialog).toBeVisible();
      await check.poll(() => fixture.received(name)).toBe(true);
    };

    await openImport.click();
    await check(page).toHaveURL(`${server.origin}/import`);
    await selectAndStart(completedFile);
    await check(dialog.getByText(/Neuladen oder Schließen des Tabs/)).toBeVisible();
    await check(dialog.getByRole("button")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.mouse.click(3, 3);
    await check(dialog).toBeVisible();

    await page.goBack();
    await check(page).toHaveURL(`${server.origin}/dashboard`);
    await check(dialog).toBeVisible();
    await confirmReload(page, false);
    await check(dialog).toBeVisible();

    fixture.release();
    await check(dialog).toBeHidden();
    await openImport.click();
    await check(page).toHaveURL(`${server.origin}/import`);
    await check(completedRow).toHaveAttribute("data-state", "completed");
    await completedRow.click();
    const deliveryNote = page.getByRole("dialog", {
      name: "Lieferschein schreiben",
    });
    await check(deliveryNote).toBeVisible();
    await page.keyboard.press("Escape");
    await check(deliveryNote).toBeHidden();

    await selectAndStart(interruptedFile);
    await confirmReload(page, true);
    await check.poll(fixture.interrupted).toBe(true);
    await check(dialog).toBeHidden();
    await check(completedRow).toHaveAttribute("data-state", "completed");
    await check(scanRow(interruptedFile)).toHaveCount(0);
    assert.equal(
      leakedToRpc,
      false,
      "Source names and recognized content must stay out of ordinary RPC",
    );

    console.log("Production browser verified: real upload and MCP, persistent modal across navigation, successful result after dismissed reload, provider cancellation and no result after confirmed reload.");
  } finally {
    fixture.release();
    await browser?.close();
    await server.close();
  }
}
