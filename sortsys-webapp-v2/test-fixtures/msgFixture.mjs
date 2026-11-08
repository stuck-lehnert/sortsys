import { burn } from "@kenjiuno/msgreader/lib/Burner.js";
import { TypeEnum } from "@kenjiuno/msgreader/lib/Reader.js";
import { emailLogo, richEmailHtml, richEmailText } from "./emailFixture.mjs";

export function makeMsgFixture({ rtfOnly = false, rich = false, htmlCodepage, messageCodepage, htmlCharset } = {}) {
  const entries = [{ name: "Root Entry", type: TypeEnum.ROOT, length: 0, children: [] }];
  function stream(parent, tag, content) {
    const data = typeof content === "string"
      ? new Uint8Array((content.length + 1) * 2) : content;
    if (typeof content === "string") {
      const view = new DataView(data.buffer);
      for (let index = 0; index < content.length; index++) view.setUint16(index * 2, content.charCodeAt(index), true);
    }
    entries[parent].children.push(entries.length);
    entries.push({ name: "__substg1.0_" + tag, type: TypeEnum.DOCUMENT, length: data.length, binaryProvider: () => data });
  }
  function folder(name) {
    const index = entries.length;
    entries[0].children.push(index);
    entries.push({ name, type: TypeEnum.DIRECTORY, length: 0, children: [] });
    return index;
  }
  stream(0, "0037001F", "Baufortschritt – Grüße");
  stream(0, "0C1A001F", "Frank Müller");
  stream(0, "5D01001F", "frank@example.test");
  if (rtfOnly) {
    const body = new TextEncoder().encode(String.raw`{\rtf1\ansi Gr\u252?\u223?e\par Lieferung morgen.}`);
    const compressed = new Uint8Array(16 + body.length);
    const header = new DataView(compressed.buffer);
    header.setUint32(0, compressed.length - 4, true);
    header.setUint32(4, body.length, true);
    header.setUint32(8, 0x414c454d, true);
    compressed.set(body, 16);
    stream(0, "10090102", compressed);
  } else {
    stream(0, "1000001F", rich ? richEmailText : "Die Lieferung kommt morgen.");
    let html = rich ? richEmailHtml : '<p>Lieferung <b>morgen</b>.</p><img src="https://tracker.invalid/pixel"><script>parent.hacked=true</script>';
    const charset = htmlCharset ?? (htmlCodepage ? htmlCodepage === 28591 ? "iso-8859-1" : "utf-8" : undefined);
    if (charset) html = `<meta charset="${charset}"><p>Grüße vom Gelände.</p>` + html;
    const encoded = charset === "iso-8859-1"
      ? new Uint8Array(Buffer.from(html.replace(/[^\u0000-\u00ff]/gu, char => `&#${char.codePointAt(0)};`), "latin1"))
      : new TextEncoder().encode(html);
    stream(0, "10130102", encoded);
  }
  const recipient = folder("__recip_version1.0_#00000000");
  stream(recipient, "3001001F", "John Doe");
  stream(recipient, "39FE001F", "john@example.test");
  const attachment = folder("__attach_version1.0_#00000000");
  stream(attachment, "3707001F", "Lieferschein.txt");
  stream(attachment, "370E001F", "text/plain");
  stream(attachment, "37010102", new TextEncoder().encode("Ware geliefert."));
  if (rich) {
    const image = folder("__attach_version1.0_#00000001");
    stream(image, "3707001F", "logo.png");
    stream(image, "370E001F", "application/octet-stream");
    stream(image, "3712001F", "<Logo@site>");
    stream(image, "37010102", new Uint8Array(Buffer.from(emailLogo, "base64")));
  }
  const codepages = [[0x3fde0003, htmlCodepage], [0x3ffd0003, messageCodepage]].filter(([, value]) => value !== undefined);
  if (codepages.length) {
    const properties = new Uint8Array(32 + codepages.length * 16);
    const view = new DataView(properties.buffer);
    for (const offset of [8, 16]) view.setUint32(offset, 1, true);
    for (const offset of [12, 20]) view.setUint32(offset, rich ? 2 : 1, true);
    for (const [index, [tag, value]] of codepages.entries()) {
      const offset = 32 + index * 16;
      view.setUint32(offset, tag, true);
      view.setUint32(offset + 4, 6, true);
      view.setUint32(offset + 8, value, true);
    }
    entries[0].children.push(entries.length);
    entries.push({ name: "__properties_version1.0", type: TypeEnum.DOCUMENT, length: properties.length, binaryProvider: () => properties });
  }
  return new Uint8Array(burn(entries)).buffer;
}
