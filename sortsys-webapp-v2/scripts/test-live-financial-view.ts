import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Client } from "@sortsys/v2-client";
import { createGaebXml } from "@sortsys/gaeb";
import type { createBusinessClient } from "../app/lib/data/businessClient";
import type { AccessValue } from "../app/lib/crypto/accessProfiles";
import { commercialCollection } from "../app/lib/data/commercialAreas";
import { commercialDocumentStore } from "../app/lib/data/commercialDocumentContent";
import { type Collection, required } from "../app/lib/data/protectedObjects";

type Business = ReturnType<typeof createBusinessClient>;
export type FinancialTestAccounts = {
  asOwner<T>(work: (business: Business) => Promise<T>): Promise<T>;
  asMember<T>(work: (business: Business) => Promise<T>): Promise<T>;
  memberClient: Client;
  grant(changes: { area: Collection; access: AccessValue }[]): Promise<void>;
};

export async function testSignedOfferView(options: FinancialTestAccounts) {
  const { asOwner, asMember, grant } = options;
  const original = readFileSync(
    new URL(
      "../../sortsys-gaeb/src/core/fixtures/signed-offer.x84",
      import.meta.url,
    ),
    "utf8",
  );
  const target = await asOwner(async (business) => {
    const offer = await required(
      business.mutate("commercial.cases.create", {
        kind: "offer",
        title: "Eingegangenes signiertes Fensterangebot",
        scopeItemIds: [],
      }),
    );
    const inquiry = await required(
      business.mutate("commercial.documents.create", {
        caseId: offer.id,
        purpose: "inquiry",
        fileName: "Fenster.x83",
        xml: referencedOfferXml("83"),
        readOnly: true,
      }),
    );
    const document = await required(
      business.mutate("commercial.documents.create", {
        caseId: offer.id,
        purpose: "offer",
        fileName: "Signiertes Fensterangebot.x84",
        xml: original,
        netAmount: "30.00",
        sourceDocumentId: inquiry.id,
        sourceVersion: 1n,
        readOnly: true,
      }),
    );
    const session = await business.documents.open(offer.id, document.id);
    assert.equal(session.canEdit, false);
    assert.equal(session.contentView?.printReadiness, "ready");
    assert.ok(session.contentView?.preparePrint);
    assert.equal(
      (await session.contentView.preparePrint(session.xml)).xml,
      original,
    );
    const native = await business.documents.blob(offer.id, document.id, "1");
    assert.equal(await native.text(), original);
    return { caseId: offer.id, documentId: document.id };
  });
  const readableFacets = [
    "master-data",
    "scope",
    "contract-quantities",
    "offer-prices",
  ] as const;
  await grant(
    readableFacets.map((facet) => ({
      area: commercialCollection(target.caseId, facet),
      access: "read" as const,
    })),
  );
  await asMember(async (business) => {
    const session = await business.documents.open(
      target.caseId,
      target.documentId,
    );
    assert.equal(session.canEdit, false);
    assert.equal(session.frozen, true);
    assert.equal(session.contentView?.access.complete, false);
    assert.equal(session.contentView?.printReadiness, "ready");
    assert.ok(session.contentView?.preparePrint);
    const printable = await session.contentView.preparePrint(session.xml);
    assert.ok(printable.xml.includes("<UP>10.000</UP>"));
    assert.ok(!printable.referenceXml?.includes("Private source estimate"));
    const result = await business.mutate("commercial.documents.save", {
      caseId: target.caseId,
      id: target.documentId,
      version: session.version,
      xml: session.xml.replace("<UP>10.000</UP>", "<UP>12.000</UP>"),
      netAmount: "36.00",
    });
    assert.ok(result[1]);
    assert.equal(
      (await business.documents.open(target.caseId, target.documentId)).version,
      1n,
    );
  });
  console.log(
    "NATIVE_SIGNED_PRINT_OK: a real RSA-signed X84 stays read-only and byte-exact; authorized partial readers can print its values without opening its signature or source notes.",
  );
}

function referencedOfferXml(phase: "83" | "84") {
  const fields = ['<Item ID="window" RNoPart="0001">'];
  if (phase === "83") {
    fields.push(
      "<Qty>3.000</Qty><QU>m²</QU>",
      "<Description><CompleteText><DetailTxt><Text>",
      "<p><span>Fensterlaibungen verputzen</span></p>",
      "</Text></DetailTxt></CompleteText></Description>",
    );
  } else {
    fields.push("<UP>10.000</UP><IT>30.00</IT>");
  }
  if (phase === "83") {
    fields.push("<!--Private source estimate 726419-->");
  }
  fields.push("</Item>");
  return createGaebXml(phase, "Fensterlaibungen", "2026-11-13").replace(
    "<BoQBody/>",
    `<BoQBody><Itemlist>${fields.join("")}</Itemlist></BoQBody>`,
  );
}

/** Two ordinary API peers exercise a quote whose X84 omits contractual
 * quantities. Only the X83 quantity grant makes pricing possible. */
export async function testReferencedOfferView(options: FinancialTestAccounts) {
  const { asOwner, asMember, memberClient, grant } = options;
  const target = await asOwner(async (business) => {
    const created = await required(
      business.mutate("commercial.cases.create", {
        kind: "offer",
        title: "Angebot mit getrennt freigegebenen Mengen 631947",
        scopeItemIds: [],
      }),
    );
    const inquiry = await required(
      business.mutate("commercial.documents.create", {
        caseId: created.id,
        purpose: "inquiry",
        fileName: "Fenster.x83",
        xml: referencedOfferXml("83"),
        readOnly: true,
      }),
    );
    const quote = await required(
      business.mutate("commercial.documents.create", {
        caseId: created.id,
        purpose: "offer",
        fileName: "Fenster.x84",
        xml: referencedOfferXml("84"),
        netAmount: "30.00",
        sourceDocumentId: inquiry.id,
        sourceVersion: 1n,
        readOnly: false,
      }),
    );
    return { caseId: created.id, inquiryId: inquiry.id, quoteId: quote.id };
  });
  await grant([
    {
      area: commercialCollection(target.caseId, "master-data"),
      access: "read",
    },
    { area: commercialCollection(target.caseId, "scope"), access: "read" },
    {
      area: commercialCollection(target.caseId, "contract-quantities"),
      access: "read",
    },
    {
      area: commercialCollection(target.caseId, "offer-prices"),
      access: "write",
    },
  ]);

  const signature = await asMember(async (business) => {
    const store = await commercialDocumentStore(
      memberClient,
      `commercial:${target.caseId}`,
      new AbortController().signal,
    );
    try {
      const before = await store.head(target.quoteId);
      const originalSource = await store.head(target.inquiryId);
      assert.ok(before);
      assert.ok(originalSource);
      assert.ok(originalSource.parts.some((part) => part.facet === "opaque"));
      assert.ok(!before.parts.some((part) => part.facet === "opaque"));
      const session = await business.documents.open(
        target.caseId,
        target.quoteId,
      );
      assert.equal(session.canEdit, true);
      assert.equal(session.contentView?.access.complete, false);
      assert.equal(session.contentView?.access.pricingSupported, true);
      assert.deepEqual(session.contentView?.access.writable, ["offer-prices"]);
      assert.ok(session.contentView?.preparePrint);
      const printable = await session.contentView.preparePrint(session.xml);
      assert.ok(printable.referenceXml?.includes("<Qty>3.000</Qty>"));
      assert.ok(!printable.referenceXml?.includes("Private source estimate"));
      assert.ok(!session.xml.includes("<Qty>"));
      assert.ok(session.referenceXml?.includes("<Qty>3.000</Qty>"));
      assert.ok(!session.referenceXml?.includes("Private source estimate"));
      const originalFile = await business.documents.blob(
        target.caseId,
        target.quoteId,
        "1",
      );
      assert.equal(await originalFile.text(), referencedOfferXml("84"));
      const edited = session.xml
        .replace("<UP>10.000</UP>", "<UP>12.000</UP>")
        .replace("<IT>30.00</IT>", "<IT>36.00</IT>");
      const saved = await required(
        business.mutate("commercial.documents.save", {
          caseId: target.caseId,
          id: target.quoteId,
          version: session.version,
          xml: edited,
        }),
      );
      assert.equal(saved.version, 2n);
      const after = await store.head(target.quoteId);
      assert.ok(after);
      assert.equal(
        (await store.head(target.inquiryId))?.signature,
        originalSource.signature,
      );
      const details = await required(
        business.query("commercial.cases.get", { id: target.caseId }),
      );
      assert.equal(details.canManage, false);
      assert.equal(details.case.netAmount, "36.00");
      await assert.rejects(() =>
        business.documents.blob(target.caseId, target.quoteId, "1")
      );
      return after.signature;
    } finally {
      store.close();
    }
  });

  await grant([
    {
      area: commercialCollection(target.caseId, "contract-quantities"),
      access: "none",
    },
  ]);
  await asMember(async (business) => {
    const session = await business.documents.open(
      target.caseId,
      target.quoteId,
    );
    assert.equal(session.canEdit, false);
    assert.equal(session.contentView?.access.pricingSupported, false);
    assert.deepEqual(session.contentView?.access.writable, []);
    assert.equal(session.contentView?.preparePrint, undefined);
    assert.ok(!session.referenceXml?.includes("<Qty>3.000</Qty>"));
    const file = await business.documents.blob(
      target.caseId,
      target.quoteId,
      "2",
    );
    const native = await file.text();
    assert.ok(native.includes("<UP>12.000</UP>"));
    assert.ok(!native.includes("<Qty>"));
    const denied = await business.mutate("commercial.documents.save", {
      caseId: target.caseId,
      id: target.quoteId,
      version: session.version,
      xml: session.xml
        .replace("<UP>12.000</UP>", "<UP>0.000</UP>")
        .replace("<IT>36.00</IT>", "<IT>0.00</IT>"),
      netAmount: "0.00",
    });
    assert.ok(
      denied[1],
      "Revoking quantities must not enable a fabricated zero amount",
    );
  });
  await grant([
    {
      area: commercialCollection(target.caseId, "contract-quantities"),
      access: "read",
    },
  ]);
  await asOwner(async (business) => {
    await required(
      business.mutate("commercial.documents.create", {
        caseId: target.caseId,
        purpose: "inquiry",
        fileName: "Fenster.x83",
        xml: referencedOfferXml("83").replace(
          "<Qty>3.000</Qty>",
          "<Qty>4.000</Qty>",
        ),
        readOnly: true,
        replaceDocumentId: target.inquiryId,
        expectedVersion: 1n,
      }),
    );
  });
  await asMember(async (business) => {
    const session = await business.documents.open(
      target.caseId,
      target.quoteId,
    );
    assert.equal(
      session.canEdit,
      false,
      "The calculation must not silently follow a new source revision",
    );
    assert.equal(session.contentView?.access.pricingSupported, true);
    assert.ok(
      session.referenceXml?.includes("<Qty>3.000</Qty>"),
      "An existing quote retains its pinned source quantity",
    );
    assert.ok(!session.referenceXml?.includes("<Qty>4.000</Qty>"));
    const denied = await business.mutate("commercial.documents.save", {
      caseId: target.caseId,
      id: target.quoteId,
      version: session.version,
      xml: session.xml,
    });
    assert.ok(denied[1]);
    const store = await commercialDocumentStore(
      memberClient,
      `commercial:${target.caseId}`,
      new AbortController().signal,
    );
    try {
      assert.equal((await store.head(target.quoteId))?.signature, signature);
    } finally {
      store.close();
    }
  });
  console.log(
    "NATIVE_FINANCIAL_VIEWS_OK: price-only edits retain opaque notes; X83 quantity grants, revocation, pinned source versions and stale-source write denial verified across both API peers.",
  );
}

/** A price editor can save intermediate work while another position still
 * has no UP. Neither the row metadata nor the UI may invent a zero total. */
export async function testUnfinishedOfferView(options: FinancialTestAccounts) {
  const { asOwner, asMember, grant } = options;
  function twoPositions(source: string) {
    const first = /<Item\b[\s\S]*?<\/Item>/.exec(source)?.[0];
    assert.ok(first);
    const second = first
      .replace('ID="window"', 'ID="second"')
      .replace('RNoPart="0001"', 'RNoPart="0002"');
    return source.replace("</Itemlist>", `${second}</Itemlist>`);
  }
  const unfinished = twoPositions(referencedOfferXml("84"))
    .replaceAll("<UP>10.000</UP>", "")
    .replaceAll("<IT>30.00</IT>", "");
  const target = await asOwner(async (business) => {
    const created = await required(
      business.mutate("commercial.cases.create", {
        kind: "offer",
        title: "Kalkulation mit noch offenen Preisen 431762",
        scopeItemIds: [],
      }),
    );
    const inquiry = await required(
      business.mutate("commercial.documents.create", {
        caseId: created.id,
        purpose: "inquiry",
        fileName: "Fenster.x83",
        xml: twoPositions(referencedOfferXml("83")),
        readOnly: true,
      }),
    );
    const quote = await required(
      business.mutate("commercial.documents.create", {
        caseId: created.id,
        purpose: "offer",
        fileName: "Fenster.x84",
        xml: unfinished,
        sourceDocumentId: inquiry.id,
        sourceVersion: 1n,
        readOnly: false,
      }),
    );
    return { caseId: created.id, quoteId: quote.id };
  });
  await grant([
    {
      area: commercialCollection(target.caseId, "master-data"),
      access: "read",
    },
    { area: commercialCollection(target.caseId, "scope"), access: "read" },
    {
      area: commercialCollection(target.caseId, "contract-quantities"),
      access: "read",
    },
    {
      area: commercialCollection(target.caseId, "offer-prices"),
      access: "write",
    },
  ]);

  await asMember(async (business) => {
    const initial = await business.documents.open(
      target.caseId,
      target.quoteId,
    );
    assert.equal(initial.canEdit, true);
    assert.equal(initial.contentView?.access.pricingSupported, true);
    assert.deepEqual(initial.contentView?.access.writable, ["offer-prices"]);
    assert.equal(initial.contentView?.printReadiness, "incomplete-pricing");
    assert.ok(initial.contentView?.preparePrint);
    await assert.rejects(
      () => initial.contentView!.preparePrint!(initial.xml),
      /print-view-incomplete/,
    );

    const partiallyPriced = initial.xml.replace(
      "</Item>",
      "<UP>10.000</UP></Item>",
    );
    const firstSave = await required(
      business.mutate("commercial.documents.save", {
        caseId: target.caseId,
        id: target.quoteId,
        version: initial.version,
        xml: partiallyPriced,
        netAmount: null,
      }),
    );
    const partialDetail = await required(
      business.query("commercial.cases.get", { id: target.caseId }),
    );
    assert.equal(partialDetail.case.netAmount, null);
    await assert.rejects(
      () => initial.contentView!.preparePrint!(partiallyPriced),
      /print-view-incomplete/,
    );

    const resumed = await business.documents.open(
      target.caseId,
      target.quoteId,
    );
    assert.equal(resumed.canEdit, true);
    assert.equal(resumed.version, firstSave.version);
    assert.ok(resumed.xml.includes("<UP>10.000</UP>"));
    assert.ok(!resumed.referenceXml?.includes("Private source estimate"));
    const completed = resumed.xml.replace(
      '<Item ID="second" RNoPart="0002"></Item>',
      '<Item ID="second" RNoPart="0002"><UP>20.000</UP></Item>',
    );
    assert.notEqual(completed, resumed.xml);
    await required(
      business.mutate("commercial.documents.save", {
        caseId: target.caseId,
        id: target.quoteId,
        version: resumed.version,
        xml: completed,
        netAmount: "90.00",
      }),
    );
    const finalDetail = await required(
      business.query("commercial.cases.get", { id: target.caseId }),
    );
    assert.equal(finalDetail.canManage, false);
    assert.equal(finalDetail.case.netAmount, "90.00");
    const printedWithoutReopening = await initial.contentView.preparePrint(
      completed,
    );
    assert.ok(printedWithoutReopening.xml.includes("<UP>20.000</UP>"));
    assert.ok(
      printedWithoutReopening.referenceXml?.includes("<Qty>3.000</Qty>"),
    );
    assert.ok(
      !printedWithoutReopening.referenceXml?.includes(
        "Private source estimate",
      ),
    );
    const finalSession = await business.documents.open(
      target.caseId,
      target.quoteId,
    );
    assert.ok(finalSession.contentView?.preparePrint);
    const native = await business.documents.blob(
      target.caseId,
      target.quoteId,
      finalSession.version.toString(),
    );
    assert.equal(await native.text(), completed);
  });
  console.log(
    "NATIVE_UNFINISHED_PRICING_OK: price-only calculation saves and resumes incomplete X84 drafts without a fabricated total, then publishes the exact completed native file.",
  );
}

export async function testQuantityWriter(options: FinancialTestAccounts) {
  const { asOwner, asMember, memberClient, grant } = options;
  const originalXml = createGaebXml(
    "85",
    "Fensteralternative",
    "2026-11-13",
  ).replace(
    "<BoQBody/>",
    '<BoQBody><Itemlist><Item ID="window" RNoPart="0001"><Qty>3.000</Qty><QU>m²</QU><UP>10.000</UP><IT>30.00</IT><Description><CompleteText><DetailTxt><Text><p><span>Fensterlaibungen verputzen</span></p></Text></DetailTxt></CompleteText></Description><!--Private estimate 39172--></Item></Itemlist></BoQBody>',
  );
  const target = await asOwner(async (business) => {
    const parent = await required(
      business.mutate("commercial.cases.create", {
        kind: "offer",
        title: "Grundangebot für Mengenrechte",
        scopeItemIds: [],
      }),
    );
    const alternative = await required(
      business.mutate("commercial.cases.create", {
        kind: "alternative",
        parentCaseId: parent.id,
        title: "Nebenangebot mit Mengenbearbeiter",
        scopeItemIds: [],
      }),
    );
    const document = await required(
      business.mutate("commercial.documents.create", {
        caseId: alternative.id,
        purpose: "alternative",
        fileName: "Fenster.x85",
        xml: originalXml,
        netAmount: "30.00",
        readOnly: false,
      }),
    );
    return { caseId: alternative.id, documentId: document.id };
  });
  const quantityRights = [
    {
      area: commercialCollection(target.caseId, "master-data"),
      access: "read" as const,
    },
    {
      area: commercialCollection(target.caseId, "scope"),
      access: "read" as const,
    },
    {
      area: commercialCollection(target.caseId, "contract-quantities"),
      access: "write" as const,
    },
    {
      area: commercialCollection(target.caseId, "offer-prices"),
      access: "read" as const,
    },
  ];
  await grant(quantityRights);
  await asMember(async (business) => {
    const store = await commercialDocumentStore(
      memberClient,
      `commercial:${target.caseId}`,
      new AbortController().signal,
    );
    try {
      const before = await store.head(target.documentId);
      assert.ok(before);
      const session = await business.documents.open(
        target.caseId,
        target.documentId,
      );
      assert.equal(session.canEdit, true);
      assert.deepEqual(session.contentView?.access.writable, [
        "contract-quantities",
      ]);
      const saved = await required(
        business.mutate("commercial.documents.save", {
          caseId: target.caseId,
          id: target.documentId,
          version: session.version,
          xml: session.xml.replace("<Qty>3.000</Qty>", "<Qty>4.000</Qty>"),
          netAmount: "40.00",
        }),
      );
      const after = await store.head(target.documentId);
      assert.ok(after);
      assert.deepEqual(
        after.parts.find((part) => part.facet === "offer-prices"),
        before.parts.find((part) => part.facet === "offer-prices"),
      );
      assert.deepEqual(
        after.parts.find((part) => part.facet === "scope"),
        before.parts.find((part) => part.facet === "scope"),
      );
      assert.notDeepEqual(
        after.parts.find((part) => part.facet === "contract-quantities"),
        before.parts.find((part) => part.facet === "contract-quantities"),
      );
      const reopened = await business.documents.open(
        target.caseId,
        target.documentId,
      );
      assert.equal(reopened.version, saved.version);
      assert.ok(reopened.xml.includes("<IT>40.00</IT>"));
      assert.ok(!reopened.xml.includes("Private estimate 39172"));
      const detail = await required(
        business.query("commercial.cases.get", { id: target.caseId }),
      );
      assert.equal(detail.case.netAmount, "40.00");
      assert.equal(
        detail.documents.find((document) => document.id === target.documentId)
          ?.netAmount,
        "40.00",
      );
      const result = await business.mutate("commercial.documents.save", {
        caseId: target.caseId,
        id: target.documentId,
        version: reopened.version,
        xml: reopened.xml.replace("<UP>10.000</UP>", "<UP>0.000</UP>"),
        netAmount: "0.00",
      });
      assert.ok(result[1]);
      assert.equal(
        (await store.head(target.documentId))?.signature,
        after.signature,
      );
      let current = reopened;
      for (
        const change of [
          {
            fromQuantity: "4.000",
            quantity: "5.000",
            fromAmount: "40.00",
            amount: "50.00",
          },
          {
            fromQuantity: "5.000",
            quantity: "4.000",
            fromAmount: "50.00",
            amount: "40.00",
          },
        ]
      ) {
        const xml = current.xml
          .replace(
            `<Qty>${change.fromQuantity}</Qty>`,
            `<Qty>${change.quantity}</Qty>`,
          )
          .replace(
            `<IT>${change.fromAmount}</IT>`,
            `<IT>${change.amount}</IT>`,
          );
        const savedAgain = await required(
          business.mutate("commercial.documents.save", {
            caseId: target.caseId,
            id: target.documentId,
            version: current.version,
            xml,
            netAmount: change.amount,
          }),
        );
        const currentHead = await store.head(target.documentId);
        assert.ok(currentHead);
        assert.deepEqual(
          currentHead.parts.find((part) => part.facet === "offer-prices"),
          before.parts.find((part) => part.facet === "offer-prices"),
        );
        current = await business.documents.open(
          target.caseId,
          target.documentId,
        );
        assert.equal(current.version, savedAgain.version);
        assert.ok(current.xml.includes(`<IT>${change.amount}</IT>`));
        const details = await required(
          business.query("commercial.cases.get", { id: target.caseId }),
        );
        assert.equal(details.case.netAmount, change.amount);
      }
    } finally {
      store.close();
    }
  });
  await asOwner(async (business) => {
    const session = await business.documents.open(
      target.caseId,
      target.documentId,
    );
    const file = await business.documents.blob(
      target.caseId,
      target.documentId,
      session.version.toString(),
    );
    assert.equal(
      await file.text(),
      originalXml
        .replace("<Qty>3.000</Qty>", "<Qty>4.000</Qty>")
        .replace("<IT>30.00</IT>", "<IT>40.00</IT>"),
    );
    for (const path of [
      "commercial.cases.list",
      "commercial.cases.overview",
    ] as const) {
      const list = await required(business.query(path, { kind: "alternative" }));
      assert.equal(
        list.find((item) => item.id === target.caseId)?.netAmount,
        "40.00",
      );
    }
  });
  await grant([
    {
      area: commercialCollection(target.caseId, "offer-prices"),
      access: "none",
    },
  ]);
  await asMember(async (business) => {
    const detail = await required(
      business.query("commercial.cases.get", { id: target.caseId }),
    );
    assert.equal(detail.case.netAmount, null);
    const overview = await required(
      business.query("commercial.cases.overview", { kind: "alternative" }),
    );
    assert.equal(
      overview.find((item) => item.id === target.caseId)?.netAmount,
      null,
    );
    const session = await business.documents.open(
      target.caseId,
      target.documentId,
    );
    assert.equal(session.canEdit, false);
    assert.ok(!session.xml.includes("<UP>"));
  });
  await grant(quantityRights);
  await asOwner(async (business) => {
    for (
      const [expectedStatus, status] of [["draft", "sent"], [
        "sent",
        "accepted",
      ]]
    ) {
      await required(
        business.mutate("commercial.cases.transition", {
          id: target.caseId,
          expectedStatus,
          status,
        }),
      );
    }
    const project = await required(
      business.mutate("commercial.cases.createProject", { id: target.caseId }),
    );
    const costs = await required(
      business.query("projects.costs.get", { projectId: project.id }),
    );
    assert.equal(
      costs.offers.find((entry) => entry.commercialCaseId === target.caseId)
        ?.amount,
      40,
    );
  });
  console.log(
    "NATIVE_QUANTITY_WRITER_OK: repeated quantity-only writes retain the exact protected price part; native XML, detail/list amounts and the accepted project's budget follow current inputs, forged prices are rejected and revocation hides amounts.",
  );
}

/** The account can read descriptions and edit invoice values, but cannot open
 * opaque estimator notes, modify master data or allocate invoice numbers. */
export async function testFinancialDraftView(
  client: Client,
  business: ReturnType<typeof createBusinessClient>,
  caseId: string,
  documentId: string,
) {
  const signal = new AbortController().signal;
  const store = await commercialDocumentStore(
    client,
    `commercial:${caseId}`,
    signal,
  );
  try {
    const before = await store.head(documentId);
    assert.ok(before);
    const secret = before.parts.find((part) => part.facet === "opaque");
    assert.ok(secret);
    const session = await business.documents.open(caseId, documentId);
    assert.equal(session.canEdit, true);
    assert.equal(session.contentView?.access.complete, false);
    assert.equal(session.contentView?.access.pricingSupported, true);
    assert.deepEqual(session.contentView?.access.writable, ["billing"]);
    assert.ok(!session.xml.includes("Private estimator note 971846"));
    await assert.rejects(
      () =>
        business.documents.blob(caseId, documentId, session.version.toString()),
      "An incomplete native file must not be offered as a complete download",
    );
    const edited = session.xml
      .replaceAll("80.00", "79.00")
      .replaceAll("95.20", "94.01");
    assert.notEqual(edited, session.xml);
    const saved = await required(
      business.mutate("commercial.documents.save", {
        caseId,
        id: documentId,
        version: session.version,
        xml: edited,
      }),
    );
    const after = await store.head(documentId);
    assert.ok(after);
    assert.deepEqual(
      after.parts.find((part) => part.facet === "opaque"),
      secret,
    );
    assert.deepEqual(
      after.parts.find((part) => part.facet === "scope"),
      before.parts.find((part) => part.facet === "scope"),
    );
    const details = await required(
      business.query("commercial.cases.get", { id: caseId }),
    );
    assert.equal(details.canManage, false);
    assert.equal(details.invoice?.totalNet, "79.00");
    assert.equal(details.case.netAmount, "79.00");
    const reopened = await business.documents.open(caseId, documentId);
    assert.ok(reopened.xml.includes("94.01"));
    const denied = await business.mutate("commercial.documents.save", {
      caseId,
      id: documentId,
      version: saved.version,
      xml: edited,
      netAmount: "0.00",
    });
    assert.ok(
      denied[1],
      "A caller cannot replace the checked amount with a forged zero",
    );
    assert.equal((await store.head(documentId))?.signature, after.signature);
    const restored = await required(
      business.mutate("commercial.documents.save", {
        caseId,
        id: documentId,
        version: saved.version,
        xml: session.xml,
      }),
    );
    assert.ok(
      (await business.documents.open(caseId, documentId)).xml.includes("95.20"),
    );
    return restored.version;
  } finally {
    store.close();
  }
}
