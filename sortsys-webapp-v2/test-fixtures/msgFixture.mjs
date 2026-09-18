import { burn } from "@kenjiuno/msgreader/lib/Burner.js";
import { TypeEnum } from "@kenjiuno/msgreader/lib/Reader.js";

export function makeMsgFixture({ rtfOnly = false } = {}) {
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
    stream(0, "1000001F", "Die Lieferung kommt morgen.");
    stream(0, "10130102", new TextEncoder().encode('<p>Lieferung <b>morgen</b>.</p><img src="https://tracker.invalid/pixel"><script>parent.hacked=true</script>'));
  }
  const recipient = folder("__recip_version1.0_#00000000");
  stream(recipient, "3001001F", "John Doe");
  stream(recipient, "39FE001F", "john@example.test");
  const attachment = folder("__attach_version1.0_#00000000");
  stream(attachment, "3707001F", "Lieferschein.txt");
  stream(attachment, "370E001F", "text/plain");
  stream(attachment, "37010102", new TextEncoder().encode("Ware geliefert."));
  return new Uint8Array(burn(entries)).buffer;
}
