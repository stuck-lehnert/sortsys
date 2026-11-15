import type { MutateInput, QueryResult } from "@sortsys/v2-client";
import type { createBusinessClient } from "../../app/lib/data/businessClient";
import { required } from "../../app/lib/data/protectedObjects";
import type { SeedProgress } from "./seed";
import {
  itemTotal,
  itemTotalCents,
  moneyFromCents,
  savedSeedItems,
  seedDocument,
  seedInvoice,
  seedItems,
  type SeedInvoiceKind,
  type SeedItem,
} from "./documents";

type Business = ReturnType<typeof createBusinessClient>;
type Case = QueryResult<"commercial.cases.get">["case"];
type CaseDetail = QueryResult<"commercial.cases.get">;
type SeedCaseState = Pick<CaseDetail, "case" | "invoice"> & {
  documents: Pick<
    CaseDetail["documents"][number],
    "id" | "purpose" | "version"
  >[];
};
type DocumentInput = MutateInput<"commercial.documents.create">;
type Source = { id: string; version: bigint; xml: string };
type Remember = (
  key: string,
  find: () => Promise<string | undefined>,
  create: () => Promise<{ id: string }>,
) => Promise<string>;

export async function seedCommercialWorkflows(
  business: Business,
  progress: SeedProgress,
  remember: Remember,
  save: () => Promise<void>,
  signal: AbortSignal,
  log?: (message: string) => void,
) {
  const existing = await required(business.query("commercial.cases.list", {}));
  const projectId = progress.ids.project!;
  const contractId = progress.ids.contract!;
  const project = await required(
    business.query("projects.get", { id: projectId }),
  );
  const customerId = progress.ids["customer-0"]!;
  const linked = { projectId, parentCaseId: contractId };
  const states = new Map<string, SeedCaseState>();
  const sources = new Map<string, Source>();

  // Keep only acknowledged seed results. Every business mutation still reads
  // and validates its own fresh permissions and CAS guards. A failed call ends
  // this run; resumption reloads the actual persisted state.
  async function detail(id: string, fresh = false): Promise<SeedCaseState> {
    signal.throwIfAborted();
    const previous = states.get(id);
    if (previous && !fresh) return previous;
    const current = await required(
      business.query("commercial.cases.get", { id }),
    );
    states.set(id, current);
    return current;
  }

  async function source(caseId: string, purpose: string): Promise<Source> {
    const entry = (await detail(caseId)).documents.find(
      (value) => value.purpose === purpose,
    );
    if (!entry) throw new Error(`Das Musterdokument ${purpose} fehlt`);
    const key = `${caseId}:${entry.id}:${entry.version}`;
    const previous = sources.get(key);
    if (previous) return previous;
    const content = await required(
      business.query("commercial.documents.get", { caseId, id: entry.id }),
    );
    const current = {
      id: entry.id,
      version: content.version,
      xml: content.xml,
    };
    sources.set(key, current);
    return current;
  }

  async function document(input: DocumentInput): Promise<Source> {
    const current = await detail(input.caseId);
    const entry = current.documents.find(
      (value) => value.purpose === input.purpose,
    );
    if (entry) return source(input.caseId, input.purpose);
    const created = await required(
      business.mutate("commercial.documents.create", input),
    );
    current.documents.push({
      id: created.id,
      purpose: input.purpose,
      version: 1n,
    });
    const content = { id: created.id, version: 1n, xml: input.xml };
    sources.set(`${input.caseId}:${created.id}:1`, content);
    return content;
  }

  async function transition(
    id: string,
    status: Case["status"],
    extra: Partial<MutateInput<"commercial.cases.transition">> = {},
  ) {
    const current = (await detail(id)).case;
    if (current.status === status) return;
    await required(
      business.mutate("commercial.cases.transition", {
        ...extra,
        id,
        expectedStatus: current.status,
        status,
      }),
    );
    current.status = status;
  }

  async function scenario(
    key: string,
    input: MutateInput<"commercial.cases.create">,
    build: (id: string) => Promise<void>,
  ) {
    if (!progress.ids[`complete-${key}`]) {
      log?.(`Beispieldaten: ${input.title}`);
    }
    const id = await remember(
      key,
      async () =>
        existing.find(
          (value) => value.kind === input.kind && value.title === input.title,
        )?.id,
      () => required(business.mutate("commercial.cases.create", input)),
    );
    if (!progress.ids[`complete-${key}`]) {
      await build(id);
      progress.ids[`complete-${key}`] = id;
      await save();
    }
    return id;
  }

  const inquiry = await source(contractId, "inquiry");
  const bid = await source(contractId, "offer");
  const items = savedSeedItems(inquiry.xml, bid.xml);
  const itemIds = items.map((item) => item.id);

  // An accepted offer is sufficient to start a project. The sample also carries
  // the employer's award and the contractor's confirmation as native documents.
  const order = await document({
    caseId: contractId,
    purpose: "order",
    fileName: "Auftrag Fenstersanierung.x86",
    xml: seedDocument("86", project.title, items),
    readOnly: true,
    sourceDocumentId: bid.id,
    sourceVersion: bid.version,
  });
  await document({
    caseId: contractId,
    purpose: "confirmation",
    fileName: "Auftragsbestätigung Fenstersanierung.x87",
    xml: seedDocument("87", project.title, items),
    readOnly: false,
    sourceDocumentId: order.id,
    sourceVersion: order.version,
  });

  async function salesDocument(
    id: string,
    title: string,
    alternative: boolean,
    projectTitle = project.title,
  ) {
    if (alternative) {
      const selected = items.slice(0, 3).map((item) => ({
        ...item,
        priceCents: Math.round(item.priceCents * 0.92),
      }));
      return document({
        caseId: id,
        purpose: "alternative",
        fileName: `${title}.x85`,
        xml: seedDocument("85", projectTitle, selected),
        netAmount: itemTotal(selected),
        readOnly: false,
        sourceDocumentId: bid.id,
        sourceVersion: bid.version,
      });
    }
    const ask = await document({
      caseId: id,
      purpose: "inquiry",
      fileName: `${title}.x83`,
      xml: seedDocument("83", projectTitle, seedItems()),
      readOnly: true,
    });
    const current = (await detail(id)).documents.find(
      (value) => value.purpose === "offer",
    );
    if (current) return source(id, "offer");
    // The original enquiry owns quantities. Only new prices are randomized.
    const prices = seedItems();
    const priced = savedSeedItems(
      ask.xml,
      seedDocument("84", projectTitle, prices),
    );
    return document({
      caseId: id,
      purpose: "offer",
      fileName: `${title}.x84`,
      xml: seedDocument("84", projectTitle, priced),
      netAmount: itemTotal(priced),
      readOnly: false,
      sourceDocumentId: ask.id,
      sourceVersion: ask.version,
    });
  }

  const salesStates = [
    "draft",
    "sent",
    "accepted",
    "rejected",
    "cancelled",
  ] as const;
  for (const kind of ["variation", "alternative"] as const) {
    for (const [index, status] of salesStates.entries()) {
      const titles =
        kind === "variation"
          ? [
              "Zusätzliche Fensterleibungen",
              "Putzergänzung Treppenhaus",
              "Anstrich Technikräume",
              "Sockelbeschichtung Nebenbau",
              "Schutzverkleidung Innenhof",
            ]
          : [
              "Alternative Kalkputz",
              "Alternative Silikatfarbe",
              "Alternative Anschlussprofile",
              "Alternative Spachteloberfläche",
              "Alternative Sockelausbildung",
            ];
      const title = titles[index]!;
      await scenario(
        `${kind}-${status}`,
        { kind, title, ...linked, customerId, scopeItemIds: [] },
        async (id) => {
          const current = (await detail(id)).case;
          if (current.status === "draft")
            await salesDocument(id, title, kind === "alternative");
          if (status === "draft") return;
          if (status === "cancelled") return transition(id, "cancelled");
          if ((await detail(id)).case.status === "draft")
            await transition(id, "sent");
          if (status !== "sent") await transition(id, status);
        },
      );
    }
  }

  const measurementAreas = {
    draft: "Nordflügel",
    submitted: "Südflügel",
    approved: "Erdgeschoss",
    cancelled: "Nebenbau",
  };
  for (const status of [
    "draft",
    "submitted",
    "approved",
    "cancelled",
  ] as const) {
    await scenario(
      `measurement-${status}`,
      {
        kind: "measurement",
        title: `Fensteraufmaß ${measurementAreas[status]}`,
        ...linked,
        scopeItemIds: itemIds,
      },
      async (id) => {
        if ((await detail(id)).case.status === "draft") {
          const title = (await detail(id)).case.title;
          await document({
            caseId: id,
            purpose: "measurement",
            fileName: `${title}.x31`,
            xml: seedDocument("31", project.title, items, title),
            readOnly: false,
            sourceDocumentId: bid.id,
            sourceVersion: bid.version,
          });
        }
        if (status === "draft") return;
        if (status === "cancelled") return transition(id, "cancelled");
        if ((await detail(id)).case.status === "draft")
          await transition(id, "submitted");
        if (status === "approved") await transition(id, "approved");
      },
    );
  }

  const calculationAreas = {
    draft: "Innenputz",
    approved: "Fensteranschlüsse",
    cancelled: "Zusatzgerüst",
  };
  for (const status of ["draft", "approved", "cancelled"] as const) {
    await scenario(
      `calculation-${status}`,
      {
        kind: "calculation",
        title: `Arbeitskalkulation ${calculationAreas[status]}`,
        ...linked,
        scopeItemIds: itemIds,
      },
      async (id) => {
        if ((await detail(id)).case.status === "draft") {
          await document({
            caseId: id,
            purpose: "calculation",
            fileName: "Arbeitskalkulation.x52",
            xml: seedDocument("52", project.title, items),
            netAmount: itemTotal(items),
            readOnly: false,
            sourceDocumentId: bid.id,
            sourceVersion: bid.version,
          });
        }
        if (status !== "draft") await transition(id, status);
      },
    );
  }

  for (const kind of ["subcontract", "procurement"] as const) {
    for (const [index, status] of [
      "draft",
      "requested",
      "awarded",
      "confirmed",
      "cancelled",
    ].entries()) {
      const trade = kind === "procurement";
      const selected = trade
        ? [
            {
              id: "material-1",
              title: "Kalkzementputz, 25-kg-Sack",
              description:
                "Mineralischer Innenputz für Fensterleibungen und Wandflächen.",
              quantity: 24,
              unit: "St",
              priceCents: 1649,
            },
            {
              id: "material-2",
              title: "Anputzleiste 6 mm",
              description:
                "Anschlussprofil mit Gewebefahne, Lieferlänge 2,4 m.",
              quantity: 36,
              unit: "St",
              priceCents: 660,
            },
          ]
        : [items[index % items.length]!];
      const scopeItemIds = trade ? [] : selected.map((item) => item.id);
      const title = `${trade ? "Preisanfrage Baustoffe" : "Weitervergabe Ausbauarbeiten"} ${index + 1}`;
      const partner = trade
        ? "Baustoffhandel Musterstadt"
        : "Ausbaupartner Mittelfranken GmbH";
      await scenario(
        `${kind}-${status}`,
        {
          kind,
          title,
          projectId,
          ...(trade ? {} : { parentCaseId: contractId }),
          scopeItemIds,
        },
        async (id) => {
          const askPurpose = trade ? "price_inquiry" : "inquiry";
          let state = (await detail(id)).case.status;
          if (state === "draft") {
            await document({
              caseId: id,
              purpose: askPurpose,
              fileName: `${title}.x${trade ? "93" : "83"}`,
              xml: seedDocument(trade ? "93" : "83", project.title, selected),
              readOnly: false,
              ...(trade
                ? {}
                : { sourceDocumentId: bid.id, sourceVersion: bid.version }),
            });
          }
          if (status === "draft") return;
          if (status === "cancelled") return transition(id, "cancelled");
          if (state === "draft") await transition(id, "requested");
          if (status === "requested") return;
          const ask = await source(id, askPurpose);
          state = (await detail(id)).case.status;
          if (state === "requested") {
            const quote = await document({
              caseId: id,
              purpose: trade ? "supplier_offer" : "offer",
              fileName: `Preisangebot.x${trade ? "94" : "84"}`,
              xml: seedDocument(trade ? "94" : "84", project.title, selected),
              netAmount: itemTotal(selected),
              partnerName: partner,
              readOnly: true,
              sourceDocumentId: ask.id,
              sourceVersion: ask.version,
            });
            await document({
              caseId: id,
              purpose: trade ? "purchase_order" : "order",
              fileName: `Beauftragung.x${trade ? "96" : "86"}`,
              xml: seedDocument(trade ? "96" : "86", project.title, selected),
              readOnly: false,
              sourceDocumentId: quote.id,
              sourceVersion: quote.version,
            });
            await transition(id, "awarded", {
              selectedOfferDocumentId: quote.id,
              ...(trade ? {} : { awardedItemIds: scopeItemIds }),
            });
          }
          if (status !== "confirmed") return;
          const purchase = await source(id, trade ? "purchase_order" : "order");
          await document({
            caseId: id,
            purpose: trade ? "supplier_confirmation" : "confirmation",
            fileName: `Auftragsbestätigung.x${trade ? "97" : "87"}`,
            xml: seedDocument(trade ? "97" : "87", project.title, selected),
            readOnly: true,
            sourceDocumentId: purchase.id,
            sourceVersion: purchase.version,
          });
          await transition(id, "confirmed");
        },
      );
    }
  }

  type InvoiceSpec = {
    key: string;
    kind: SeedInvoiceKind;
    title: string;
    parentCaseId: string;
    projectId: string;
    projectTitle: string;
    items: SeedItem[];
    basis?: "work" | "lump_sum";
    status: "draft" | "sent" | "partially_paid" | "paid" | "cancelled";
  };
  async function invoice(spec: InvoiceSpec) {
    return scenario(
      spec.key,
      {
        kind: spec.kind,
        title: spec.title,
        projectId: spec.projectId,
        parentCaseId: spec.parentCaseId,
        billingBasis: spec.basis ?? "work",
        vatRate: "19.00",
        scopeItemIds: spec.items.map((item) => item.id),
      },
      async (id) => {
        let current = await detail(id);
        if (current.case.status === "draft") {
          const context = await required(
            business.query("commercial.invoices.context", {
              contractCaseId: spec.parentCaseId,
            }),
          );
          const previous =
            spec.kind === "final_invoice" ? context.progressInvoices : [];
          const deductedNet = previous.reduce(
            (sum, value) => sum + Math.round(Number(value.netAmount) * 100),
            0,
          );
          const deductedGross = previous.reduce(
            (sum, value) => sum + Math.round(Number(value.grossAmount) * 100),
            0,
          );
          await document({
            caseId: id,
            purpose: "invoice",
            fileName: `${spec.title}.x89`,
            readOnly: false,
            xml: seedInvoice(
              spec.kind,
              spec.projectTitle,
              spec.items,
              deductedGross,
            ),
            netAmount: moneyFromCents(itemTotalCents(spec.items) - deductedNet),
          });
          if (spec.status === "draft") return;
          if (spec.status === "cancelled") return transition(id, "cancelled");
          await required(business.mutate("commercial.invoices.issue", { id }));
        }
        if (["partially_paid", "paid"].includes(spec.status)) {
          current = await detail(id, true);
          const bill = current.invoice!;
          const gross = Math.round(Number(bill.grossAmount) * 100);
          const alreadyPaid = Math.round(Number(bill.paidAmount) * 100);
          const target = spec.status === "paid" ? gross : Math.floor(gross / 2);
          if (target > alreadyPaid) {
            await required(
              business.mutate("commercial.invoices.recordPayment", {
                id,
                amount: moneyFromCents(target - alreadyPaid),
                paidOn: new Date().toISOString().slice(0, 10),
                reference: `Überweisung ${spec.title}`,
              }),
            );
          }
        }
      },
    );
  }

  const invoiceParent = {
    parentCaseId: contractId,
    projectId,
    projectTitle: project.title,
  };
  await invoice({
    ...invoiceParent,
    key: "progress-work",
    kind: "progress_invoice",
    title: "1. Abschlagsrechnung Innenausbau",
    items: items.slice(0, 2),
    status: "paid",
  });
  const advance: SeedItem[] = [
    {
      id: "pauschale-1",
      title: "Pauschaler Abschlag Ausbauarbeiten",
      description: "Abschlag auf den beauftragten Innenausbau.",
      quantity: 1,
      unit: "psch",
      priceCents: Math.floor(itemTotalCents(items) / 10),
    },
  ];
  await invoice({
    ...invoiceParent,
    key: "progress-lump",
    kind: "progress_invoice",
    title: "2. Abschlagsrechnung pauschal",
    items: advance,
    basis: "lump_sum",
    status: "partially_paid",
  });
  await invoice({
    ...invoiceParent,
    key: "progress-cancelled",
    kind: "progress_invoice",
    title: "Verworfener Abschlagsentwurf",
    items: items.slice(2, 3),
    status: "cancelled",
  });
  await invoice({
    ...invoiceParent,
    key: "progress-draft",
    kind: "progress_invoice",
    title: "Nächster Abschlag zur Bearbeitung",
    items: items.slice(2, 4),
    status: "draft",
  });
  await invoice({
    ...invoiceParent,
    key: "final-sent",
    kind: "final_invoice",
    title: "Schlussrechnung Fenstersanierung",
    items,
    status: "sent",
  });

  // Separate contracts keep single invoices out of the progress/final chain.
  async function separateInvoiceParent(key: string, title: string) {
    const mainId = await scenario(
      key,
      {
        kind: "offer",
        title,
        customerId,
        scopeItemIds: [],
      },
      async (id) => {
        if ((await detail(id)).case.status === "draft")
          await salesDocument(id, title, false, title);
        if ((await detail(id)).case.status === "draft")
          await transition(id, "sent");
        if ((await detail(id)).case.status === "sent")
          await transition(id, "accepted");
      },
    );
    const invoiceProject = await required(
      business.mutate("commercial.cases.createProject", { id: mainId }),
    );
    const scope = await source(mainId, "inquiry");
    const priced = await source(mainId, "offer");
    return {
      parentCaseId: mainId,
      projectId: invoiceProject.id,
      projectTitle: title,
      items: savedSeedItems(scope.xml, priced.xml),
    };
  }
  for (const [index, status] of (
    ["draft", "sent", "partially_paid", "paid"] as const
  ).entries()) {
    const title = [
      "Innenanstrich Vereinsheim",
      "Putzarbeiten Werkstatt",
      "Fensteranschlüsse Bürohaus",
      "Renovierung Hausflur",
    ][index]!;
    const parent = await separateInvoiceParent(
      `invoice-contract-${status}`,
      title,
    );
    if (status === "draft") {
      await invoice({
        ...parent,
        key: "invoice-cancelled",
        kind: "invoice",
        title: `Verworfener Rechnungsentwurf ${title}`,
        status: "cancelled",
      });
    }
    await invoice({
      ...parent,
      key: `invoice-${status}`,
      kind: "invoice",
      title: `Rechnung ${title}`,
      status,
    });
  }
  const openSettlement = await separateInvoiceParent(
    "final-draft-contract",
    "Fassadenarbeiten Kulturhaus",
  );
  await invoice({
    ...openSettlement,
    key: "progress-sent",
    kind: "progress_invoice",
    title: "Abschlagsrechnung Kulturhaus",
    items: openSettlement.items.slice(0, 2),
    status: "sent",
  });
  await invoice({
    ...openSettlement,
    key: "final-draft",
    kind: "final_invoice",
    title: "Schlussrechnungsentwurf Kulturhaus",
    status: "draft",
  });
}
