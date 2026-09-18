import { describe, expect, test } from "bun:test";
import { attachmentPreviewKind } from "./attachmentPreview.ts";
import { parseEmail, safeEmailFileName, isSafeInlineImage, MAX_EMAIL_BYTES } from "./emailPreview.ts";
import { sanitizeEmailHtml, safeEmailLink, emailPreviewDocument } from "./emailSanitizer.ts";
import { decode, encode } from "./msgTextEncoding.ts";
import { decompressMsgRtf, rtfToText } from "./msgRtf.ts";
import { makeMsgFixture } from "../../test-fixtures/msgFixture.mjs";

const toBytes = value => new TextEncoder().encode(value).buffer;

describe("attachment dispatch", () => {
  test("recognizes PDF and mail independently of extension case and generic MIME types", () => {
    expect(attachmentPreviewKind({ fileName: "Scan.PDF", mimeType: "application/octet-stream" })).toBe("pdf");
    expect(attachmentPreviewKind({ fileName: "scan", mimeType: "application/pdf; charset=binary" })).toBe("pdf");
    expect(attachmentPreviewKind({ fileName: "Email.EML", mimeType: "application/octet-stream" })).toBe("eml");
    expect(attachmentPreviewKind({ fileName: "Email.MSG", mimeType: "application/octet-stream" })).toBe("msg");
    expect(attachmentPreviewKind({ fileName: "Email", mimeType: "message/rfc822" })).toBe("eml");
    expect(attachmentPreviewKind({ fileName: "Email", mimeType: "application/vnd.ms-outlook" })).toBe("msg");
    expect(attachmentPreviewKind({ fileName: "Report.docx", mimeType: "application/octet-stream" })).toBeNull();
  });
});

describe("email conversion", () => {
  test("decodes MIME headers, quoted-printable text, and binary attachments", async () => {
    const result = await parseEmail(toBytes([
      "From: =?UTF-8?Q?Frank_M=C3=BCller?= <frank@example.test>",
      "To: John Doe <john@example.test>",
      "Subject: =?UTF-8?Q?Gr=C3=BC=C3=9Fe_von_der_Baustelle?=",
      "Date: Thu, 17 Sep 2026 14:00:00 +0200",
      "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="test"', "",
      "--test", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: quoted-printable", "",
      "Gr=C3=BC=C3=9Fe! Lieferung morgen.", "--test",
      "Content-Type: application/pdf", 'Content-Disposition: attachment; filename="../Lieferschein.pdf"',
      "Content-Transfer-Encoding: base64", "", "JVBERi0xLjcK", "--test--",
    ].join("\r\n")), "eml");
    expect(result.subject).toBe("Grüße von der Baustelle");
    expect(result.from).toContain("Frank Müller");
    expect(result.to).toContain("john@example.test");
    expect(result.text).toContain("Grüße! Lieferung morgen.");
    expect(new Date(result.date).toISOString()).toBe("2026-09-17T12:00:00.000Z");
    expect(result.attachments[0].fileName).toBe("Lieferschein.pdf");
    expect(new TextDecoder().decode(result.attachments[0].content)).toBe("%PDF-1.7\n");
  });

  test("reads a real compound MSG with Unicode properties and an attachment", async () => {
    const result = await parseEmail(makeMsgFixture(), "msg");
    expect(result.subject).toBe("Baufortschritt – Grüße");
    expect(result.from).toContain("Frank Müller");
    expect(result.from).toContain("frank@example.test");
    expect(result.to).toContain("john@example.test");
    expect(result.text).toContain("Die Lieferung kommt morgen.");
    expect(result.html).toContain("<b>morgen</b>");
    expect(result.html).not.toContain("tracker.invalid");
    expect(result.html).not.toContain("script");
    expect(result.attachments[0].fileName).toBe("Lieferschein.txt");
    expect(new TextDecoder().decode(result.attachments[0].content)).toBe("Ware geliefert.");
  });

  test("preserves forwarded emails as downloadable attachments", async () => {
    const result = await parseEmail(toBytes([
      "From: frank@example.test", "Subject: Forward", "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="parts"', "", "--parts",
      "Content-Type: text/plain", "", "See attachment.", "--parts",
      "Content-Type: message/rfc822", "", "From: john@example.test", "Subject: Nested", "", "Nested body.", "--parts--",
    ].join("\r\n")), "eml");
    expect(result.attachments[0].mimeType).toBe("message/rfc822");
    expect(new TextDecoder().decode(result.attachments[0].content)).toContain("Nested body.");
  });

  test("converts an RTF-only compound Outlook message to readable text", async () => {
    const result = await parseEmail(makeMsgFixture({ rtfOnly: true }), "msg");
    expect(result.text).toBe("Grüße\nLieferung morgen.");
    expect(result.html).toBe("");
    expect(result.attachments[0].fileName).toBe("Lieferschein.txt");
  });

  test("embeds raster CID images but rejects attached SVG and remote tracking images", async () => {
    const result = await parseEmail(toBytes([
      "From: frank@example.test", "Subject: Inline images", "MIME-Version: 1.0",
      'Content-Type: multipart/related; boundary="parts"', "", "--parts",
      "Content-Type: text/html; charset=utf-8", "",
      '<p>Photo:</p><img src="CID:photo"><img src="cid:vector"><img src="https://tracker.invalid">',
      "--parts", "Content-Type: image/png", "Content-ID: <photo>", "Content-Transfer-Encoding: base64", "",
      "iVBORw0KGgo=", "--parts", "Content-Type: image/svg+xml", "Content-ID: <vector>",
      "Content-Transfer-Encoding: base64", "", "PHN2Zy8+", "--parts--",
    ].join("\r\n")), "eml");
    expect(result.html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(result.html).not.toContain("svg");
    expect(result.html).not.toContain("tracker.invalid");
    expect(result.attachments).toHaveLength(2);
  });

  test("rejects malformed and oversized input", async () => {
    await expect(parseEmail(toBytes("not an email"), "eml")).rejects.toThrow("invalid-email");
    await expect(parseEmail(toBytes("not an Outlook file"), "msg")).rejects.toThrow();
    await expect(parseEmail(new ArrayBuffer(MAX_EMAIL_BYTES + 1), "eml")).rejects.toThrow("email-too-large");
  });

  test("cleans attachment filenames and checks image signatures", () => {
    expect(safeEmailFileName("C:\\uploads\\test\u0000.txt")).toBe("test.txt");
    expect(safeEmailFileName("../../invoice.pdf")).toBe("invoice.pdf");
    expect(isSafeInlineImage({ mimeType: "image/png", content: toBytes("<svg onload=alert(1)>") })).toBe(false);
    expect(isSafeInlineImage({ mimeType: "image/svg+xml", content: toBytes("<svg/>") })).toBe(false);
  });
});

describe("HTML allowlist", () => {
  test("keeps formatting while stripping active content, tracking, style and event attributes", () => {
    const html = sanitizeEmailHtml('<p style="background:url(https://evil.test)" onclick="alert(1)">Hello <b>world</b></p><script>alert(1)</script><iframe src="https://evil.test"></iframe><img src="https://evil.test/pixel"><form action="https://evil.test"><input name="secret"></form>');
    expect(html).toBe("<p>Hello <b>world</b></p>");
  });

  test("blocks encoded and malformed dangerous links and foreign-content mutation XSS", () => {
    const html = sanitizeEmailHtml('<a href="java&#x73;cript:alert(1)">bad</a><svg><a href="https://evil.test">svg</a></svg><math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">');
    expect(html).not.toContain("href=");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<math");
    expect(html).not.toContain("<img");
  });

  test("only explicit HTTP(S) and mailto links survive, with referrer protection", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,hello", "//evil.test", "/api", "https://user:pass@example.test", "https://example.test/\nsecret"]) expect(safeEmailLink(url)).toBeNull();
    const html = sanitizeEmailHtml('<a href="https://example.test/?a=1&amp;b=2">Site</a><a href="mailto:john@example.test">Mail</a>');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('referrerpolicy="no-referrer"');
    expect(html).toContain("mailto:john@example.test");
  });

  test("only trusted CID images are embedded; input data URLs and SVG are removed", () => {
    const images = new Map([["photo", "data:image/png;base64,iVBORw0KGgo="]]);
    const html = sanitizeEmailHtml('<img src="cid:photo" onerror="evil()"><img src="data:image/svg+xml,evil"><img src="https://tracker.test">', images);
    expect(html).toBe('<img src="data:image/png;base64,iVBORw0KGgo=" alt="">');
  });

  test("removes all unlisted attributes and constrains table dimensions", () => {
    const html = sanitizeEmailHtml('<table id="x" background="https://evil.test"><tr><td colspan="999999" rowspan="2" data-x="y">Cell</td></tr></table>');
    expect(html).toContain('rowspan="2"');
    expect(html).not.toContain("999999");
    expect(html).not.toContain("background");
    expect(html).not.toContain("data-x");
  });

  test("isolates the document with a restrictive CSP", () => {
    const document = emailPreviewDocument("<p>Text</p>");
    expect(document).toContain("default-src 'none'");
    expect(document).toContain("form-action 'none'");
    expect(document).toContain("connect-src 'none'");
    expect(document).toContain('name="referrer" content="no-referrer"');
  });

  test("bounds deeply nested bodies", () => {
    expect(() => sanitizeEmailHtml("<div>".repeat(100) + "Text" + "</div>".repeat(100))).toThrow("email-too-large");
  });
});

test("native MSG character decoding preserves umlauts and Outlook code pages", () => {
  expect(decode(new Uint8Array([71, 114, 252, 223, 101]), "windows-1252")).toBe("Grüße");
  expect(decode(encode("Grüße", "utf-16le"), "ucs2")).toBe("Grüße");
  expect(decode(new TextEncoder().encode("Grüße"), "65001")).toBe("Grüße");
});

test("RTF conversion preserves Unicode and paragraphs while discarding objects and metadata", () => {
  expect(rtfToText(String.raw`{\rtf1\ansi{\fonttbl{\f0 Arial;}}Gr\u252?\u223?e\par Lieferung {\object unsafe}morgen.}`))
    .toBe("Grüße\nLieferung morgen.");
});

test("RTF decompression supports uncompressed and literal-compressed payloads with size limits", () => {
  const body = new TextEncoder().encode(String.raw`{\rtf1 Test\par Body}`);
  const make = compressed => {
    const payload = compressed ? Array.from(body).flatMap((byte, index) => index % 8 === 0 ? [0, byte] : [byte]) : Array.from(body);
    const bytes = new Uint8Array(16 + payload.length);
    const header = new DataView(bytes.buffer);
    header.setUint32(0, bytes.length - 4, true);
    header.setUint32(4, body.length, true);
    header.setUint32(8, compressed ? 0x75465a4c : 0x414c454d, true);
    bytes.set(payload, 16);
    return bytes;
  };
  expect(rtfToText(decompressMsgRtf(make(false)))).toBe("Test\nBody");
  expect(rtfToText(decompressMsgRtf(make(true)))).toBe("Test\nBody");
  const bomb = make(false);
  new DataView(bomb.buffer).setUint32(4, 50_000_000, true);
  expect(() => decompressMsgRtf(bomb)).toThrow("email-too-large");
  expect(() => decompressMsgRtf(new Uint8Array(2))).toThrow("invalid-email");
});
