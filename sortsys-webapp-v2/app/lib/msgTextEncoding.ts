// MSGReader only needs byte/string conversion from iconv-lite. Native decoders
// keep Node's Buffer and stream shims out of the browser worker.
export function decode(bytes: Uint8Array, encoding: string): string {
  const label = encoding.toLowerCase().replace(/[_-]/g, "");
  const codePages: Record<string, string> = {
    "65001": "utf-8", "1200": "utf-16le", "1201": "utf-16be",
    "932": "shift_jis", "936": "gbk", "949": "euc-kr", "950": "big5",
  };
  const normalized = codePages[label] ?? (label === "utf16le" || label === "ucs2" ? "utf-16le"
    : label === "utf16be" ? "utf-16be"
    : label === "utf8" ? "utf-8"
    : /^(?:cp|win|windows)?[0-9]+$/.test(label) ? "windows-" + label.replace(/\D/g, "")
    : encoding);
  return new TextDecoder(normalized).decode(bytes);
}

export function encode(value: string, encoding: string): Uint8Array {
  if (/^(?:utf-?16le|ucs-?2)$/i.test(encoding)) {
    const bytes = new Uint8Array(value.length * 2);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < value.length; index++) view.setUint16(index * 2, value.charCodeAt(index), true);
    return bytes;
  }
  if (!/^utf-?8$/i.test(encoding)) throw new Error("Unsupported MSG output encoding");
  return new TextEncoder().encode(value);
}
