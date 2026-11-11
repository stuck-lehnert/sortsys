import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { base64 } from "@sortsys/zerotrust";
import { contentId } from "./projectFileData";
import { PRINT_OBJECT, assetDetails, printAsset, printTemplatePayload, templateRevision, printTemplateWire, readTemplateResource, templateResource } from "./printTemplateData";
import { renderPrintSvg, validatePrintAssetBytes } from "./printAssetBytes";

const version = "a".repeat(32), hash = base64(new Uint8Array(32));
function asset(overrides = {}) { return { id: "1", name: "Logo.png", mimeType: "image/png", sizeBytes: 8,
  content: { version, size: 8, parts: [{ id: contentId("organization", "1", version, 0), hash }] }, ...overrides }; }
const xml = value => new TextEncoder().encode(value);

test("print manifests enforce media limits, file identity and organization-only block bindings", () => {
  expect(printAsset(asset())).toEqual(asset());
  for (const bad of [asset({ id: "2" }), asset({ name: "../Logo.png" }), asset({ name: ".Logo.png" }), asset({ mimeType: "text/html" }),
    asset({ sizeBytes: 0 }), asset({ sizeBytes: 20971521 }), asset({ secret: "extra" }), asset({ content: { ...asset().content, size: 9 } }),
    asset({ content: { ...asset().content, parts: [{ id: contentId("2", "1", version, 0), hash }] } }),
    asset({ content: { ...asset().content, version: "legacy-thumbnail", parts: [{ id: contentId("organization", "1", "legacy-thumbnail", 0), hash }] } })]) expect(() => printAsset(bad)).toThrow();
  expect(assetDetails("Logo.PNG", "image/png", 1)).toEqual({ name: "Logo.PNG", mimeType: "image/png", sizeBytes: 1 });
  expect(() => readTemplateResource("https://outside.example/logo.png")).toThrow();
  expect(readTemplateResource(templateResource(asset()))).toEqual({ id: "1", version });
});

test("print source revisions preserve exact Typst and reject injected payload properties", async () => {
  const source = "// Äöü\n#let header = [Bau GmbH]\n";
  const payload = { format: "sortsys-print-template-v1", source, assets: [asset()] };
  expect(await templateRevision(source)).toBe(createHash("sha256").update(source).digest("hex"));
  expect(await templateRevision(null)).toBe("0");
  const wire = await printTemplateWire(printTemplatePayload(payload, PRINT_OBJECT));
  expect(wire.source).toBe(source); expect(wire.assets[0].downloadUrl).toBe(templateResource(asset()));
  for (const value of [{ ...payload, arbitrary: true }, { ...payload, source: " " }, { ...payload, source: "\0" }, { ...payload, source: "ü".repeat(262145) },
    { ...payload, assets: [asset(), asset()] }]) expect(() => printTemplatePayload(value, PRINT_OBJECT)).toThrow();
  expect(() => printTemplatePayload(payload, "organization:profile:current")).toThrow();
});

test("print media is checked before decoding and supports static SVG with embedded raster images", () => {
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(() => validatePrintAssetBytes("image/png", png)).not.toThrow();
  expect(() => validatePrintAssetBytes("application/pdf", xml("%PDF-1.4\n"))).not.toThrow();
  expect(() => validatePrintAssetBytes("image/png", xml("<svg/>"))).toThrow();
  for (const svg of ["<svg><path fill='url(#gradient)'/></svg>", "<?xml version='1.0' encoding='UTF-8'?><svg><style>.a {fill:rgb(0,0,0)}</style><path class='a'/></svg>",
    `<svg><image href="data:image/png;base64,${Buffer.from(png).toString("base64")}"/></svg>`]) expect(() => validatePrintAssetBytes("image/svg+xml", xml(svg))).not.toThrow();
});

test("SVG print assets cannot load network images, stylesheets, scripts or animated references", () => {
  for (const svg of ["<svg><image href='https://outside.example/a.png'/></svg>", "<svg><use href='//outside.example/a.svg#id'/></svg>",
    "<svg xmlns:x='http://www.w3.org/1999/xlink'><image x:href='https://outside.example/a.png'/></svg>",
    "<svg><image href='&#x68;ttps://outside.example/a.png'/></svg>", "<svg><style>@import 'https://outside.example/a.css';</style></svg>",
    "<svg style='background-image:image-set(\"https://outside.example/a.png\")'/>", "<svg><style>path{fill:u\\72l(https://outside.example)}</style></svg>",
    "<?xml-stylesheet href='https://outside.example/a.css'?><svg/>", "<!DOCTYPE svg [<!ENTITY e SYSTEM 'https://outside.example'>]><svg/>",
    "<svg onload='alert(1)'/>", "<svg><script>alert(1)</script></svg>", "<svg><foreignObject><img src='https://outside.example/a.png'/></foreignObject></svg>",
    "<svg><animate attributeName='href' values='https://outside.example/a.png'/></svg>", "<svg xml:base='https://outside.example'><use href='#x'/></svg>",
    "<svg><image href='data:image/svg+xml;base64,PHN2Zy8+' /></svg>"] ) expect(() => validatePrintAssetBytes("image/svg+xml", xml(svg))).toThrow();
});

test("the SVG render copy canonicalizes namespaces while preserving the encrypted original", () => {
  const original = xml('<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="http://www.w3.org/2000/svg" xmlns:meta="https://vendor.example/ns"><metadata><meta:record>Private vendor details</meta:record></metadata><x:rect width="2" height="2" fill="red"/></svg>');
  const before = original.slice(), rendered = new TextDecoder().decode(renderPrintSvg(original));
  expect(original).toEqual(before); expect(rendered).not.toContain("vendor.example"); expect(rendered).not.toContain("Private vendor details");
  expect(rendered).toContain('<rect width="2" height="2" fill="red">'); expect(rendered).toContain('xmlns="http://www.w3.org/2000/svg"');
  const compatible = new TextDecoder().decode(renderPrintSvg(xml('<svg xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#old" href="#new"/></svg>')));
  expect(compatible.match(/href=/g)).toHaveLength(1); expect(compatible).toContain('href="#new"');
  for (const svg of ['<svg xmlns:x="http://www.w3.org/2000/svg"><x:script>alert(1)</x:script></svg>',
    '<svg><g xmlns="http://www.w3.org/1999/xhtml"><iframe src="https://outside.example"/></g></svg>']) expect(() => renderPrintSvg(xml(svg))).toThrow();
});
