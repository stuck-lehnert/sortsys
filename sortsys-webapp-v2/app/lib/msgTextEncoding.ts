// MSGReader only needs byte/string conversion from iconv-lite. Native decoders
// keep Node's Buffer and stream shims out of the browser worker.
const codePages: Record<string, string> = {
  "65001": "utf-8", "1200": "utf-16le", "1201": "utf-16be",
  "866": "ibm866", "874": "windows-874",
  "932": "shift_jis", "936": "gbk", "949": "euc-kr", "950": "big5",
  "10000": "macintosh", "10007": "x-mac-cyrillic", "10017": "x-mac-cyrillic",
  "20127": "us-ascii", "20866": "koi8-r", "21866": "koi8-u",
  "28591": "iso-8859-1", "28592": "iso-8859-2", "28593": "iso-8859-3",
  "28594": "iso-8859-4", "28595": "iso-8859-5", "28596": "iso-8859-6",
  "28597": "iso-8859-7", "28598": "iso-8859-8", "28599": "iso-8859-9",
  "28603": "iso-8859-13", "28605": "iso-8859-15",
  "50220": "iso-2022-jp", "50221": "iso-2022-jp", "50222": "iso-2022-jp",
  "51932": "euc-jp", "51949": "euc-kr", "54936": "gb18030",
};

function encodingLabel(encoding: string): string {
  const label = encoding.trim().toLowerCase().replace(/[_-]/g, "");
  const number = /^(?:cp|win|windows)?([0-9]+)$/.exec(label)?.[1];
  return (number && codePages[number]) || (label === "utf16le" || label === "ucs2" ? "utf-16le"
    : label === "utf16be" ? "utf-16be"
    : label === "utf8" ? "utf-8"
    : number ? "windows-" + number
    : encoding);
}

export function supportedMsgEncoding(encoding: string): string | null {
  try { return new TextDecoder(encodingLabel(encoding)).encoding; }
  catch { return null; }
}

export function decode(bytes: Uint8Array, encoding: string): string {
  return new TextDecoder(encodingLabel(encoding)).decode(bytes);
}

export function decodeMsgHtml(bytes: Uint8Array, codePage: number | undefined, charset: string | undefined): string {
  for (const value of [codePage ? String(codePage) : undefined, charset]) {
    const encoding = value ? supportedMsgEncoding(value) : null;
    if (encoding) return decode(bytes, encoding);
  }
  if (bytes[0] === 255 && bytes[1] === 254) return decode(bytes, "utf-16le");
  if (bytes[0] === 254 && bytes[1] === 255) return decode(bytes, "utf-16be");
  // Unsupported metadata must not discard an otherwise readable message.
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return decode(bytes, "windows-1252"); }
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
