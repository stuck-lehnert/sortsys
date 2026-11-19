import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect as playwrightExpect } from "playwright/test";
import { applicationServer } from "./applicationServer.mjs";

assert.equal(process.env.SORTSYS_DISPOSABLE_AUTH_TEST, "1");
const env = process.env;
const endpoints = JSON.parse(env.SORTSYS_AUTH_TEST_ENDPOINTS);
assert.equal(endpoints.length, 2);
const project = env.SORTSYS_RESTORE_E2E_PROJECT;
const confirmationCase = env.SORTSYS_RESTORE_E2E_CONFIRMATION_CASE;
const invoiceCase = env.SORTSYS_RESTORE_E2E_INVOICE_CASE;
const finalizedText = "Vertrauliche Ausführung nach der Sicherung.";
const paymentReference = "Anzahlung vom Bauherrn 736284";
const before = env.SORTSYS_RESTORE_E2E_BEFORE;
const after = env.SORTSYS_RESTORE_E2E_AFTER;
const photo = env.SORTSYS_RESTORE_E2E_PHOTO;
const reportDay = env.SORTSYS_RESTORE_E2E_REPORT_DAY;
const printAsset = env.SORTSYS_RESTORE_E2E_PRINT_ASSET;
const printHeader = env.SORTSYS_RESTORE_E2E_PRINT_HEADER;
const delivery = env.SORTSYS_RESTORE_E2E_DELIVERY;
const deliveryComment = env.SORTSYS_RESTORE_E2E_DELIVERY_COMMENT;
const productName = env.SORTSYS_RESTORE_E2E_PRODUCT;
assert.ok(
  project &&
    confirmationCase &&
    invoiceCase &&
    before &&
    after &&
    photo &&
    reportDay &&
    printAsset &&
    printHeader &&
    delivery &&
    deliveryComment &&
    productName,
);
const artifacts = join(process.argv[2], "browser-artifacts", "content-restore");
await mkdir(artifacts, { recursive: true });
const server = await applicationServer(
  new URL("../../build/client", import.meta.url).pathname,
  endpoints[1],
);
const expect = playwrightExpect.configure({ timeout: 25_000 });
let browser;
let context;
try {
  browser = await chromium.launch({ executablePath: env.SORTSYS_E2E_CHROMIUM });
  context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "de-DE",
  });
  await context.tracing.start({
    screenshots: true,
    snapshots: true,
    sources: true,
  });
  const page = await context.newPage();
  const unauthorized = page.getByRole("button", {
    name: "Anmelden",
    exact: true,
  });
  const errors = [];
  const leaks = [];
  let activations = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/v2/")) return;
    if (url.pathname.includes("zerotrust.content.activate")) activations++;
    const wire = (request.postData() ?? "") + decodeURIComponent(url.search);
    const privateTexts = [
      before,
      after,
      finalizedText,
      paymentReference,
      photo,
      printAsset,
      printHeader,
      deliveryComment,
      productName,
    ];
    if (privateTexts.some((text) => wire.includes(text))) {
      leaks.push(url.pathname);
    }
  });

  const backupsUrl = server.origin + "/admin?tab=backups";
  await page.goto(backupsUrl);
  await expect(unauthorized).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "Sicherungen", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("textbox", { name: /^Nutzername/ })
    .fill(`${env.SORTSYS_RESTORE_E2E_USER}@${env.SORTSYS_NATIVE_AUTH_TENANT}`);
  await page.getByLabel(/^Passwort/).fill(env.SORTSYS_RESTORE_E2E_PASSWORD);
  await unauthorized.click();
  await expect(
    page.getByRole("link", { name: "Einstellungen", exact: true }),
  ).toBeVisible();
  await page.goto(backupsUrl);

  const backups = page.getByRole("button", {
    name: "Sicherung prüfen",
    exact: true,
  });
  await expect(backups).toHaveCount(2);
  await backups.last().click();
  const dialog = page.getByRole("dialog", {
    name: "Sicherung wiederherstellen",
    exact: true,
  });
  const confirm = dialog.getByRole("button", {
    name: "Fachdaten wiederherstellen",
    exact: true,
  });
  await expect(confirm).toBeEnabled();
  await expect(dialog.getByText("Projekte", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Dateien", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Ordner", { exact: true })).toBeVisible();
  const printFiles = dialog.getByText("Druckdateien", { exact: true });
  await expect(printFiles).toBeVisible();
  await expect(printFiles.locator("..").locator("dd")).toHaveText("2");
  for (const label of ["Lieferscheine", "Regieberichte"]) {
    const entry = dialog.getByText(label, { exact: true });
    await expect(entry.locator("..").locator("dd")).toHaveText("1");
  }
  await expect(
    dialog.getByText(
      /In der Sicherung fehlen Produkte, die in Lieferscheinen oder Regieberichten verwendet werden/,
    ),
  ).toBeVisible();
  await expect(
    dialog.getByText("Erhaltene Dokumente", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: join(artifacts, "restore-preview.png") });
  await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  assert.equal(activations, 0);

  const projectUrl = server.origin + `/projects/${project}`;
  await page.goto(projectUrl);
  await expect(
    page.getByRole("heading", { name: before, exact: true }),
  ).toBeVisible();
  await page.goto(backupsUrl);
  await backups.last().click();
  await confirm.click({ timeout: 60_000 });
  await expect(page.getByText(/Wiederhergestellter Stand/)).toBeVisible();
  await page.screenshot({ path: join(artifacts, "restore-confirmed.png") });
  await page.goto(projectUrl);
  await expect(
    page.getByRole("heading", { name: after, exact: true }),
  ).toBeVisible();
  await page.goto(`${projectUrl}/dailyReports/${reportDay}`);
  const thumbnail = page.getByRole("img", { name: photo, exact: true });
  await expect(thumbnail).toBeVisible();
  await expect
    .poll(() => thumbnail.evaluate((image) => image.naturalWidth))
    .toBe(2);
  await page.goto(`${server.origin}/products/deliveryNotes/${delivery}`);
  await expect(page.getByText(deliveryComment, { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: productName, exact: true }),
  ).toBeVisible();
  await page.goto(`${server.origin}/admin?tab=logo`);
  const logo = page.getByRole("img", {
    name: "Organisationslogo",
    exact: true,
  });
  await expect(logo).toBeVisible();
  await expect.poll(() => logo.evaluate((image) => image.naturalWidth)).toBe(4);
  await page
    .getByRole("tab", { name: "Dokumentvorlagen", exact: true })
    .click();
  await expect(page.getByText(printAsset, { exact: true })).toBeVisible();
  const printPreview = page.getByTitle("PDF ansehen", { exact: true });
  await expect(printPreview).toBeVisible();
  const previewFrame = await (
    await printPreview.elementHandle()
  ).contentFrame();
  assert.ok(previewFrame);
  await previewFrame.waitForFunction(
    () => !!window.PDFViewerApplication?.pdfDocument,
  );
  const printPreviewText = await previewFrame.evaluate(async () => {
    const pdf = window.PDFViewerApplication.pdfDocument;
    const firstPage = await pdf.getPage(1);
    const text = await firstPage.getTextContent();
    return text.items
      .map(({ str }) => str)
      .join(" ")
      .replace(/\s+/g, " ");
  });
  assert.ok(printPreviewText.includes(printHeader), printPreviewText);
  await page.goto(`${server.origin}/gaeb/${confirmationCase}`);
  await page
    .getByRole("button", {
      name: "Auftragsbestätigung öffnen",
      exact: true,
    })
    .click();
  await expect(page.locator("canvas").first()).toBeVisible();
  const finalParagraph = page.locator(
    `[data-gaeb-field][aria-description="${finalizedText}"]`,
  );
  await expect(finalParagraph).toBeVisible();
  await expect(finalParagraph).toBeDisabled();
  await page.screenshot({
    path: join(artifacts, "restored-locked-confirmation.png"),
  });
  await page.goto(`${server.origin}/gaeb/${invoiceCase}`);
  await expect(page.locator("canvas").first()).toBeVisible();
  await page
    .getByRole("button", { name: "Zahlungseingang", exact: true })
    .click();
  const payments = page.getByRole("dialog", {
    name: "Zahlungseingänge",
    exact: true,
  });
  await expect(payments.getByText(/Offener Betrag.*27,60/)).toBeVisible();
  await expect(payments.getByText(new RegExp(paymentReference))).toBeVisible();
  await page.screenshot({
    path: join(artifacts, "restored-invoice-payments.png"),
    animations: "disabled",
  });
  assert.equal(activations, 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(leaks, []);
  await writeFile(
    join(artifacts, "results.json"),
    JSON.stringify({
      success: true,
      visibleBackups: 2,
      previewCancelled: true,
      activations,
      lockedConfirmationVisible: true,
      invoicePaymentVisible: true,
      restoredPhotoVisible: true,
      restoredDeliveryVisible: true,
      missingProductReported: true,
      restoredPrintFilesVisible: true,
      errors,
      leaks,
    }),
  );
} finally {
  await context?.tracing.stop({ path: join(artifacts, "trace.zip") });
  await browser?.close();
  await server.close();
}
