import React from "react";
import { Observable } from "rxjs";
import { MemoryRouter } from "react-router";
import { NotificationProvider } from "@sortsys/react-components/notifications";
import { OrganizationLogoSettings } from "../../app/components/OrganizationLogoSettings";
import { SessionInfoProvider } from "../../app/hooks/useSessionInfo";
import { client, organizationLogo } from "../../app/lib/client";
import { I18nProvider } from "../../app/lib/i18n";
import { createBusinessClient } from "../../app/lib/data/businessClient";
import { createContentAccess } from "../../app/lib/data/menuAccess";
import { LOGO_COLLECTION, LOGO_OBJECT } from "../../app/lib/data/logoData";
import { protectedTenant } from "../../app/lib/data/testing/protectedTenant.mjs";
import { prepareLogoImage } from "../../app/lib/logoImage";
import pdfWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import { renderStructuredPdf } from "../../app/lib/pdf";
import { lockCryptoSession } from "../../app/lib/crypto/session";

export async function showLogo(
  root,
  { locale = "de", theme = "light", readonly = false, fail = false } = {},
) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.dataset.theme = theme;
  document.body.dataset.ssTheme = theme;
  const tenant = await protectedTenant([LOGO_COLLECTION], () =>
    readonly ? ["read"] : ["read", "create", "update"],
  );
  await tenant.seed(LOGO_COLLECTION, LOGO_OBJECT, {
    format: "sortsys-organization-logo-v1",
    image: null,
    issue: null,
  });
  tenant.state.discardCommit = fail;
  const controller = new AbortController();
  const access = createContentAccess(tenant.client, () => controller.signal);
  const business = createBusinessClient(tenant.client);
  client.query = business.query;
  client.mutate = business.mutate;
  client.streamQuery = business.streamQuery;
  client.invalidate = business.invalidate;
  Object.assign(organizationLogo, business.logo);
  const sessionClient = {
    loggedIn: () => true,
    streamQuery: () =>
      new Observable((subscriber) => {
        let active = true;
        void tenant.client.query("auth.sessionInfo").then(([session]) => {
          if (active)
            subscriber.next([
              {
                ...session,
                user: { ...session.user, locale },
                tenant: { objectStorageEnabled: false },
              },
              null,
            ]);
        });
        return () => {
          active = false;
        };
      }),
  };
  window.cryptoFixture.logoState = async () => ({
    calls: tenant.calls,
    value: await tenant.plain(LOGO_COLLECTION, LOGO_OBJECT),
  });
  window.cryptoFixture.allowLogoSave = () => {
    tenant.state.discardCommit = false;
  };
  window.cryptoFixture.lockLogo = () => lockCryptoSession();
  window.cryptoFixture.prepareLogo = async (
    base64,
    name,
    mime,
    cancel = false,
  ) => {
    const controller = new AbortController();
    if (cancel) controller.abort();
    const prepared = await prepareLogoImage(
      new File([Uint8Array.fromBase64(base64)], name, { type: mime }),
      controller.signal,
    );
    const image = await createImageBitmap(prepared.blob);
    try {
      const canvas = new OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      return {
        width: prepared.width,
        height: prepared.height,
        fileName: prepared.fileName,
        mime: prepared.blob.type,
        samples: [
          [0, 0],
          [image.width - 1, image.height - 1],
          [Math.floor(image.width / 2), 1],
          [Math.floor(image.width / 2), image.height - 2],
        ].map(([x, y]) => [...context.getImageData(x, y, 1, 1).data]),
      };
    } finally {
      image.close();
    }
  };
  window.cryptoFixture.printLogo = async () => {
    const bytes = await renderStructuredPdf({
      title: "Materialübersicht",
      reportLabel: "Fenstersanierung",
      exportedAt: new Date("2026-11-14T12:00:00Z"),
      sections: [
        {
          title: "Material",
          columns: ["Bezeichnung", "Menge"],
          rows: [["Putzprofil", "12 m"]],
        },
      ],
      layout: {
        sender: {
          name: "Musterbau GmbH",
          lines: ["Bauweg 7", "90408 Nürnberg"],
        },
      },
    });
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;
    const task = pdfjs.getDocument({
      data: bytes.slice(),
      useSystemFonts: false,
    });
    try {
      const pdf = await task.promise;
      const page = await pdf.getPage(1);
      const operators = await page.getOperatorList();
      const images = operators.fnArray.filter((operation) =>
        [
          pdfjs.OPS.paintImageXObject,
          pdfjs.OPS.paintInlineImageXObject,
        ].includes(operation),
      ).length;
      const canvas = document.createElement("canvas");
      const viewport = page.getViewport({ scale: 1.25 });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({
        canvas,
        canvasContext: canvas.getContext("2d"),
        viewport,
      }).promise;
      return {
        bytes: [...bytes],
        images,
        png: canvas.toDataURL("image/png").split(",")[1],
      };
    } finally {
      await task.destroy();
    }
  };
  root.render(
    <I18nProvider>
      <MemoryRouter>
        <SessionInfoProvider sessionClient={sessionClient} access={access}>
          <NotificationProvider>
            <main className="p-4">
              <h1>
                {locale === "de" ? "Organisationslogo" : "Organization logo"}
              </h1>
              <OrganizationLogoSettings />
            </main>
          </NotificationProvider>
        </SessionInfoProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}
