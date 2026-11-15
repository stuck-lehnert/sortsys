import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { createGaebXml } from "./templates";
import {
  type GaebContentFacet,
  type GaebXmlFragment,
  partitionGaebXml,
  renderGaebXml,
  updateGaebView,
} from "./privacy";
import { assessGaebPrintView, prepareGaebPrintView } from "./printView";

const IMAGE =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

// This fixture's unsigned document and SignedInfo are already exclusive
// canonical XML, generated with xmllint. This is not a general XMLDSig verifier.
function assertFixtureSignatureIntact(xml: string) {
  const signature = /<ds:Signature\b[^>]*>[\s\S]*?<\/ds:Signature>/.exec(xml)
    ?.[0];
  assert.ok(signature);
  const info = /<ds:SignedInfo\b[^>]*>[\s\S]*?<\/ds:SignedInfo>/.exec(signature)
    ?.[0];
  assert.ok(info);
  function value(name: string): string {
    const match = new RegExp(`<ds:${name}>([^<]+)</ds:${name}>`).exec(
      signature!,
    );
    assert.ok(match);
    return match[1]!;
  }
  assert.equal(
    createHash("sha256").update(xml.replace(signature, "")).digest("base64"),
    value("DigestValue"),
  );
  const key = createPublicKey({
    format: "jwk",
    key: {
      kty: "RSA",
      n: Buffer.from(value("Modulus"), "base64").toString("base64url"),
      e: Buffer.from(value("Exponent"), "base64").toString("base64url"),
    },
  });
  assert.equal(
    verify(
      "sha256",
      Buffer.from(info),
      key,
      Buffer.from(value("SignatureValue"), "base64"),
    ),
    true,
  );
}
function source(phase: "83" | "84" | "86" = "86", extra = "", richExtra = "") {
  const fields = ['<Item ID="window" RNoPart="0001">'];
  if (phase !== "84") {
    fields.push("<Qty>3.000</Qty><QU>m²</QU>");
  }
  if (phase !== "83") {
    fields.push("<UP>10.000</UP><IT>30.00</IT>");
  }
  if (phase !== "84") {
    fields.push(
      "<Description><CompleteText><DetailTxt><Text><p><span>Fensterlaibungen verputzen</span></p>",
      richExtra,
      "</Text></DetailTxt></CompleteText></Description>",
    );
  }
  fields.push(extra, "</Item>");
  return createGaebXml(phase, "Fenstersanierung", "2026-11-13").replace(
    "<BoQBody/>",
    `<BoQBody><Itemlist>${fields.join("")}</Itemlist></BoQBody>`,
  );
}
function partial(
  xml: string,
  readable: readonly GaebContentFacet[] = [
    "scope",
    "contract-quantities",
    "offer-prices",
  ],
) {
  const all = partitionGaebXml(xml, "offer");
  const basis = {
    layout: all.layout,
    fragments: all.fragments.filter((fragment) =>
      readable.includes(fragment.facet)
    ),
  };
  const groups = new Map<GaebXmlFragment["facet"], GaebXmlFragment[]>();
  for (const fragment of basis.fragments) {
    const group = groups.get(fragment.facet) ?? [];
    group.push(fragment);
    groups.set(fragment.facet, group);
  }
  return { basis, ...renderGaebXml(basis.layout, groups) };
}

test("a printable contract view keeps private sibling notes sealed", () => {
  const view = partial(source("86", "<!--Private estimate 978412-->"));
  assert.equal(view.complete, false);
  const print = prepareGaebPrintView({
    source: view.xml,
    basis: view.basis,
    kind: "offer",
    writable: [],
  });
  assert.ok(print);
  assert.ok(print.xml.includes("Fensterlaibungen verputzen"));
  assert.ok(!print.xml.includes("Private estimate"));
  assert.equal(
    print.xml,
    view.xml,
    "Preparing a print does not rewrite the native view",
  );
});

test("printing an unchanged signed X84 retains its real RSA signature while every edit remains forbidden", () => {
  const xml = readFileSync(
    new URL("./fixtures/signed-offer.x84", import.meta.url),
    "utf8",
  );
  assertFixtureSignatureIntact(xml);
  const basis = partitionGaebXml(xml, "offer");
  assert.equal(basis.layout.signed, true);
  assert.throws(() => updateGaebView(xml, "offer", basis, []));
  const request = {
    source: xml,
    basis,
    kind: "offer",
    writable: ["offer-prices"] as const,
    reference: partitionGaebXml(source("83"), "offer"),
    needsReference: true,
  };
  const printable = prepareGaebPrintView(request);
  assert.ok(printable);
  assert.equal(printable.xml, xml);
  assertFixtureSignatureIntact(printable.xml);
  for (
    const changed of [
      xml.replace("<UP>10.000</UP>", "<UP>12.000</UP>"),
      xml.replace("</GAEB>", " </GAEB>"),
    ]
  ) {
    assert.throws(() => prepareGaebPrintView({ ...request, source: changed }));
  }
});

test("missing quantities and prices never become a printable zero offer", () => {
  for (
    const readable of [
      ["scope"],
      ["scope", "offer-prices"],
      ["scope", "contract-quantities"],
    ] as const
  ) {
    const view = partial(source(), readable);
    assert.equal(
      prepareGaebPrintView({
        source: view.xml,
        basis: view.basis,
        kind: "offer",
        writable: [],
      }),
      null,
    );
  }
});

test("print readiness distinguishes unfinished prices from unread content and updates against the same basis", () => {
  const original = source("86", "<!--Private estimate 978412-->")
    .replace("<UP>10.000</UP>", "");
  const view = partial(original);
  const request = {
    source: view.xml,
    basis: view.basis,
    kind: "offer",
    writable: ["offer-prices"] as const,
  };
  assert.deepEqual(assessGaebPrintView(request), {
    status: "incomplete-pricing",
  });
  assert.equal(prepareGaebPrintView(request), null);
  const completed = view.xml.replace("<IT>", "<UP>10.000</UP><IT>");
  const assessment = assessGaebPrintView({ ...request, source: completed });
  assert.equal(assessment.status, "ready");
  assert.ok(prepareGaebPrintView({ ...request, source: completed }));

  const image = `<image Type="image/png" Encoding="base64">${IMAGE}</image>`;
  const imageView = partial(original.replace("</p>", `${image}</p>`));
  assert.deepEqual(
    assessGaebPrintView({
      ...request,
      source: imageView.xml,
      basis: imageView.basis,
    }),
    { status: "unread-content" },
  );
});

test("full native drafts also need their prices while fully readable special rules retain declared amounts", () => {
  const unfinished = partial(source().replace("<UP>10.000</UP>", ""));
  assert.equal(unfinished.complete, true);
  assert.deepEqual(
    assessGaebPrintView({
      source: unfinished.xml,
      basis: unfinished.basis,
      kind: "offer",
      writable: [],
    }),
    { status: "incomplete-pricing" },
  );
  const specialSource = source().replace(
    "<Qty>",
    "<UPComp1>10.000</UPComp1><Qty>",
  );
  const full = partial(specialSource);
  assert.equal(full.complete, true);
  assert.equal(
    assessGaebPrintView({
      source: full.xml,
      basis: full.basis,
      kind: "offer",
      writable: [],
    }).status,
    "ready",
  );
  const hidden = partial(specialSource + "<!--Private estimate 978412-->");
  assert.deepEqual(
    assessGaebPrintView({
      source: hidden.xml,
      basis: hidden.basis,
      kind: "offer",
      writable: [],
    }),
    { status: "unsupported-pricing" },
  );
});

test("images use their attachment key and unread rich content blocks printing", () => {
  const image =
    `<image Type="image/png" Encoding="base64" Name="Fensterdetail.png">${IMAGE}</image>`;
  const original = source("86", "", image);
  const view = partial(original);
  assert.ok(view.missing.includes("attachment"));
  assert.equal(
    view.basis.fragments.some((fragment) => fragment.facet === "opaque"),
    false,
  );
  assert.equal(
    prepareGaebPrintView({
      source: view.xml,
      basis: view.basis,
      kind: "offer",
      writable: [],
    }),
    null,
  );
  const withImages = partial(original, [
    "scope",
    "contract-quantities",
    "offer-prices",
    "attachment",
  ]);
  assert.ok(
    prepareGaebPrintView({
      source: withImages.xml,
      basis: withImages.basis,
      kind: "offer",
      writable: [],
    })?.xml.includes(IMAGE),
  );
  const unknown = partial(
    source(
      "86",
      "",
      '<vendor:Text xmlns:vendor="urn:vendor">Unbekannter sichtbarer Zusatz</vendor:Text>',
    ),
  );
  assert.equal(
    prepareGaebPrintView({
      source: unknown.xml,
      basis: unknown.basis,
      kind: "offer",
      writable: [],
    }),
    null,
  );
});

test("a referenced X84 prints readable X83 quantities and text without opening its notes", () => {
  const target = partial(source("84"));
  const reference = partial(
    source("83", "<!--Private source estimate 629417-->"),
    ["scope", "contract-quantities"],
  );
  const request = {
    source: target.xml,
    basis: target.basis,
    kind: "offer",
    writable: [],
    reference: reference.basis,
  };
  const print = prepareGaebPrintView(request);
  assert.ok(print?.referenceXml?.includes("<Qty>3.000</Qty>"));
  assert.ok(!print?.referenceXml?.includes("Private source estimate"));
  assert.ok(!print?.xml.includes("<Qty>"));
  const noQuantities = partial(source("83"), ["scope"]);
  assert.equal(
    prepareGaebPrintView({ ...request, reference: noQuantities.basis }),
    null,
  );
  const withImage = partial(
    source(
      "83",
      "",
      `<image Type="image/png" Encoding="base64">${IMAGE}</image>`,
    ),
    ["scope", "contract-quantities"],
  );
  assert.equal(
    prepareGaebPrintView({ ...request, reference: withImage.basis }),
    null,
  );
});

test("a print cannot omit unread bidder text in the reference", () => {
  const target = partial(source("84"));
  const reference = partial(
    source(
      "83",
      "<BidComm><p><span>Verbindliche Ergänzung</span></p></BidComm>",
    ),
    ["scope", "contract-quantities"],
  );
  assert.equal(
    prepareGaebPrintView({
      source: target.xml,
      basis: target.basis,
      kind: "offer",
      writable: [],
      reference: reference.basis,
    }),
    null,
  );
});

test("measurement printing requires images only in the measured source positions", () => {
  const extra = source(
    "83",
    "",
    `<image Type="image/png" Encoding="base64">${IMAGE}</image>`,
  )
    .match(/<Item ID="window"[\s\S]*<\/Item>/)![0]
    .replace('ID="window"', 'ID="other"')
    .replace('RNoPart="0001"', 'RNoPart="0002"');
  const reference = partial(
    source("83").replace("</Itemlist>", `${extra}</Itemlist>`),
    ["scope", "contract-quantities"],
  );
  const xml = createGaebXml("31", "Aufmaß", "2026-11-13").replace(
    "<BoQBody/>",
    '<BoQBody><Itemlist><Item ID="window" RNoPart="0001"><QtyDeterm><Qty>2.000</Qty></QtyDeterm></Item></Itemlist></BoQBody>',
  );
  const target = partial(xml, ["scope", "measurement"]);
  const request = {
    source: target.xml,
    basis: target.basis,
    kind: "offer",
    writable: [],
    reference: reference.basis,
    needsReference: true,
  };
  assert.ok(prepareGaebPrintView(request));
  assert.ok(
    prepareGaebPrintView({
      ...request,
      reference: partial(source("83"), ["scope"]).basis,
    }),
    "A measured quantity does not require the source's contractual quantity key",
  );
  const selectedImage = partial(
    xml
      .replace('ID="window"', 'ID="other"')
      .replace('RNoPart="0001"', 'RNoPart="0002"'),
    ["scope", "measurement"],
  );
  assert.equal(
    prepareGaebPrintView({
      ...request,
      source: selectedImage.xml,
      basis: selectedImage.basis,
    }),
    null,
  );
  assert.equal(
    prepareGaebPrintView({ ...request, reference: undefined }),
    null,
  );
});

test("print preparation checks writable areas, stored totals and preserved references", () => {
  const view = partial(source("86", "<!--Private estimate 978412-->"));
  assert.throws(() =>
    prepareGaebPrintView({
      source: view.xml.replace("<UP>10.000</UP>", "<UP>12.000</UP>"),
      basis: view.basis,
      kind: "offer",
      writable: [],
    })
  );
  assert.throws(
    () =>
      prepareGaebPrintView({
        source: view.xml.replace("<IT>30.00</IT>", "<IT>0.00</IT>"),
        basis: view.basis,
        kind: "offer",
        writable: ["offer-prices"],
      }),
    /item-total/,
  );
  const edited = view.xml
    .replace("<UP>10.000</UP>", "<UP>12.000</UP>")
    .replace("<IT>30.00</IT>", "<IT>36.00</IT>");
  assert.ok(
    prepareGaebPrintView({
      source: edited,
      basis: view.basis,
      kind: "offer",
      writable: ["offer-prices"],
    }),
  );
});

test("native measurement rows remain readable with the measurement key", () => {
  const xml = createGaebXml("31", "Aufmaß Fenster", "2026-11-13").replace(
    "<BoQBody/>",
    `<BoQBody><Itemlist><Item ID="window" RNoPart="0001"><QtyDeterm><Qty>3.000</Qty><QDetermItem><QTakeoff Row="${
      " ".repeat(80)
    }"/></QDetermItem></QtyDeterm></Item></Itemlist></BoQBody>`,
  );
  const named = xml.replace(
    "<QtyDeterm><QtyDetermInfo>",
    "<QtyDeterm><PrjInfo><RefPrjName>Schulsanierung Nordflügel</RefPrjName></PrjInfo><QtyDetermInfo>",
  );
  const view = partial(named, ["scope", "measurement"]);
  assert.equal(view.complete, true);
  assert.equal(view.missing.includes("opaque"), false);
  assert.ok(view.xml.includes("QTakeoff"));
  assert.ok(view.xml.includes("Schulsanierung Nordflügel"));
  const without = partial(xml, ["scope"]);
  assert.equal(
    prepareGaebPrintView({
      source: without.xml,
      basis: without.basis,
      kind: "offer",
      writable: [],
    }),
    null,
  );
});

test("trade recipient addresses retain all printed name lines with the scope key", () => {
  const xml = createGaebXml("93", "Material", "2026-11-13").replace(
    "</OrderInfo>",
    "</OrderInfo><SupplierInfo><Address><Name1>Baustoffhandel</Name1><Name4>Abteilung Baustelle Nord</Name4></Address></SupplierInfo><!--Private calculation 91824-->",
  );
  const view = partial(xml, ["scope"]);
  assert.equal(view.complete, false);
  assert.ok(view.xml.includes("Baustoffhandel"));
  assert.ok(view.xml.includes("Abteilung Baustelle Nord"));
  assert.ok(!view.xml.includes("Private calculation"));
  assert.ok(
    prepareGaebPrintView({
      source: view.xml,
      basis: view.basis,
      kind: "offer",
      writable: [],
    }),
  );
});
