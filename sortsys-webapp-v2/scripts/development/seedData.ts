import { readFile } from "node:fs/promises";
import type { createBusinessClient } from "../../app/lib/data/businessClient";
import { required } from "../../app/lib/data/protectedObjects";
import type { SeedProgress } from "./seed";
import { itemTotal, seedDocument, seedItems } from "./documents";
import { seedCommercialWorkflows } from "./seedCommercial";

type Business = ReturnType<typeof createBusinessClient>;

export async function seedBusinessData(
  business: Business,
  progress: SeedProgress,
  save: () => Promise<void>,
  signal: AbortSignal,
  log?: (message: string) => void,
) {
  async function remember(
    key: string,
    find: () => Promise<string | undefined>,
    create: () => Promise<{ id: string }>,
  ): Promise<string> {
    signal.throwIfAborted();
    if (progress.ids[key]) return progress.ids[key];
    const id = (await find()) ?? (await create()).id;
    progress.ids[key] = id;
    await save();
    return id;
  }

  if (progress.complete || progress.baseDataComplete) {
    await seedCommercialWorkflows(
      business,
      progress,
      remember,
      save,
      signal,
      log,
    );
    return;
  }

  const organization = await required(
    business.query("settings.organization.get", undefined),
  );
  if (!organization.companyName) {
    await required(
      business.mutate("settings.organization.set", {
        companyName: "Musterbau & Ausbau GmbH",
        address: {
          streetAddress: "Handwerkerstraße 12",
          zip: "90402",
          city: "Nürnberg",
          country: "DE",
        },
      }),
    );
  }
  const owner = await required(
    business.query("users.get", { id: progress.ids.john! }),
  );
  if (!owner.lastName) {
    await required(
      business.mutate("users.update", {
        id: owner.id,
        data: {
          firstName: "John",
          lastName: "Doe",
          email: "john.doe@example.invalid",
          costPerHour: 48.5,
          vacationDaysPerYear: 30,
        },
      }),
    );
  }
  const customers = [
    "Nürnberger Wohnbau GmbH",
    "Schulverband Musterstadt",
    "Hausverwaltung Am Park",
  ];
  for (const [index, name] of customers.entries()) {
    await remember(
      `customer-${index}`,
      async () =>
        (
          await required(business.query("customers.list", { search: name }))
        ).find((value) => value.name === name)?.id,
      () =>
        required(
          business.mutate("customers.create", {
            name,
            address: {
              streetAddress: `${["Parkstraße", "Schulstraße", "Lindenweg"][index]} ${index + 4}`,
              city: "Nürnberg",
              zip: "90403",
              country: "DE",
            },
            emailAddresses: [
              {
                email: `bauleitung-${index}@example.invalid`,
                name: "Bauleitung",
              },
            ],
          }),
        ),
    );
  }
  const materials = [
    [
      "Haftgrund",
      "l",
      "Haftvermittler für saugende mineralische Untergründe",
      890,
    ],
    [
      "Kalkzementputz",
      "kg",
      "Werktrockenmörtel für Innenputz und Fensterleibungen",
      68,
    ],
    [
      "Dispersionsfarbe Weiß",
      "l",
      "Matte Innenwandfarbe, Nassabriebklasse 2",
      640,
    ],
    [
      "Anputzleiste 6 mm",
      "m",
      "Anschlussprofil für Fenster- und Türrahmen",
      275,
    ],
  ] as const;
  for (const [
    index,
    [name, baseUnit, description, cents],
  ] of materials.entries()) {
    const customId = 900001 + index;
    const id = await remember(
      `product-${index}`,
      async () =>
        (
          await required(business.query("products.list", { search: name }))
        ).find((value) => value.customId === customId)?.id,
      () =>
        required(
          business.mutate("products.create", {
            customId,
            name,
            baseUnit,
            description,
            brand: "Musterbaustoffe",
          }),
        ),
    );
    if (!progress.ids[`price-${index}`]) {
      const created = await required(
        business.mutate("products.priceRecords.create", {
          productId: id,
          pricePerBaseUnit: cents / 100,
          timestamp: new Date("2026-01-01T00:00:00Z"),
          isRealPurchase: false,
        }),
      );
      progress.ids[`price-${index}`] = created.id;
      await save();
    }
  }
  for (const [index, category] of [
    "Bohrhammer",
    "Rührwerk",
    "Baustellenleuchte",
  ].entries()) {
    await remember(
      `tool-${index}`,
      async () =>
        (await required(business.query("tools.list", {}))).find(
          (value) => value.customId === 910001 + index,
        )?.id,
      () =>
        required(
          business.mutate("tools.create", {
            customId: 910001 + index,
            brand: "Musterwerkzeug",
            category,
            label: `${category} ${index + 1}`,
            purchasePrice: 250 + index * 120,
            usageCostPerDay: 5 + index * 2,
          }),
        ),
    );
  }

  async function offer(
    key: string,
    title: string,
    status: "draft" | "sent" | "accepted" | "rejected" | "cancelled",
    inquiryOnly = false,
  ) {
    const caseId = await remember(
      key,
      async () =>
        (
          await required(
            business.query("commercial.cases.list", { search: title }),
          )
        ).find((value) => value.title === title && value.kind === "offer")?.id,
      () =>
        required(
          business.mutate("commercial.cases.create", {
            kind: "offer",
            title,
            customerId: progress.ids["customer-0"],
            scopeItemIds: [],
          }),
        ),
    );
    let detail = await required(
      business.query("commercial.cases.get", { id: caseId }),
    );
    let inquiry = detail.documents.find(
      (document) => document.purpose === "inquiry",
    );
    const items = seedItems();
    if (!inquiry) {
      const created = await required(
        business.mutate("commercial.documents.create", {
          caseId,
          purpose: "inquiry",
          fileName: `${title}.x83`,
          xml: seedDocument("83", title, items),
          readOnly: true,
        }),
      );
      detail = await required(
        business.query("commercial.cases.get", { id: caseId }),
      );
      inquiry = detail.documents.find(
        (document) => document.id === created.id,
      )!;
    }
    if (
      !inquiryOnly &&
      !detail.documents.some((document) => document.purpose === "offer")
    ) {
      // Read the saved scope on retries so pricing never invents different quantities.
      const source = await required(
        business.query("commercial.documents.get", { caseId, id: inquiry.id }),
      );
      const quantities = [
        ...source.xml.matchAll(
          /<Item ID="([^"]+)"[\s\S]*?<Qty>([^<]+)<\/Qty>/g,
        ),
      ];
      const priced = items.map((item) => {
        const quantity = quantities.find((value) => value[1] === item.id)?.[2];
        if (quantity === undefined || !Number.isFinite(Number(quantity)))
          throw new Error(
            "Die Mengen der Musteranfrage konnten nicht gelesen werden",
          );
        return { ...item, quantity: Number(quantity) };
      });
      await required(
        business.mutate("commercial.documents.create", {
          caseId,
          purpose: "offer",
          fileName: `${title}.x84`,
          xml: seedDocument("84", title, priced),
          netAmount: itemTotal(priced),
          readOnly: false,
          sourceDocumentId: inquiry.id,
          sourceVersion: source.version,
        }),
      );
    }
    detail = await required(
      business.query("commercial.cases.get", { id: caseId }),
    );
    if (status !== "draft" && detail.case.status === "draft") {
      await required(
        business.mutate("commercial.cases.transition", {
          id: caseId,
          expectedStatus: "draft",
          status: "sent",
        }),
      );
    }
    if (
      ["accepted", "rejected", "cancelled"].includes(status) &&
      detail.case.status !== status
    ) {
      await required(
        business.mutate("commercial.cases.transition", {
          id: caseId,
          expectedStatus: "sent",
          status,
        }),
      );
    }
    return caseId;
  }

  const contract = await offer(
    "contract",
    "Fenstersanierung Pirckheimer-Gymnasium",
    "accepted",
  );
  const project = await required(
    business.mutate("commercial.cases.createProject", { id: contract }),
  );
  progress.ids.project = project.id;
  await save();
  await offer("inquiry", "Innenputz Neubau Am Stadtpark", "draft", true);
  await offer("draft", "Treppenhausrenovierung Musterstraße", "draft");
  await offer("sent", "Fassadensanierung Lindenweg", "sent");
  await offer("rejected", "Anstrich Lagerhalle Nord", "rejected");
  await offer("cancelled", "Putzergänzung Nebengebäude", "cancelled");

  const attachments = [
    ["grundriss-erdgeschoss.dwg", "image/vnd.dwg"],
    ["grundriss-erdgeschoss.pdf", "application/pdf"],
    ["grundriss-obergeschoss.dwg", "image/vnd.dwg"],
    ["grundriss-obergeschoss.pdf", "application/pdf"],
    ["baubesprechung.msg", "application/vnd.ms-outlook"],
    ["baubesprechung.eml", "message/rfc822"],
    ["materialfreigabe.pdf", "application/pdf"],
  ] as const;
  for (const [name, mime] of attachments) {
    const key = `attachment-${name}`;
    if (progress.ids[key]) continue;
    const files = await required(
      business.query("projects.files.list", { projectId: project.id }),
    );
    const existing = files.find((file) => file.fileName === name);
    progress.ids[key] =
      existing?.id ??
      (await business.files.upload({
        projectId: project.id,
        name,
        mime,
        blob: new Blob(
          [
            await readFile(
              new URL(
                `../../../sortsys-api-v2/seed-assets/${name}`,
                import.meta.url,
              ),
            ),
          ],
          { type: mime },
        ),
      }));
    await save();
  }
  progress.baseDataComplete = true;
  await save();
  await seedCommercialWorkflows(
    business,
    progress,
    remember,
    save,
    signal,
    log,
  );
}
