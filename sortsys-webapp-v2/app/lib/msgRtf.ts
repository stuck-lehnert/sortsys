const MAX_RTF_BYTES = 3 * 1024 * 1024;

export function decompressMsgRtf(bytes: Uint8Array): string {
  if (bytes.length < 16) throw new Error("invalid-email");
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = header.getUint32(0, true) + 4;
  const size = header.getUint32(4, true);
  const magic = header.getUint32(8, true);
  if (size > MAX_RTF_BYTES) throw new Error("email-too-large");
  if (end > bytes.length || end < 16) throw new Error("invalid-email");
  if (magic === 0x414c454d) {
    if (16 + size > end) throw new Error("invalid-email");
    return new TextDecoder("windows-1252").decode(bytes.subarray(16, 16 + size));
  }
  if (magic !== 0x75465a4c) throw new Error("invalid-email");

  // MS-OXRTFCP's initial 4096-byte dictionary. Output is preallocated to the
  // declared size and bounded independently of the compressed input.
  const seed = "{\\rtf1\\ansi\\mac\\deff0\\deftab720{\\fonttbl;}{\\f0\\fnil \\froman \\fswi"
    + "ss \\fmodern \\fscript \\fdecor MS Sans SerifSymbolArialTimes New Ro"
    + "manCourier{\\colortbl\\red0\\green0\\blue0\r\n\\par \\pard\\plain\\f0\\fs20\\"
    + "b\\i\\u\\tab\\tx";
  const dictionary = new Uint8Array(4096);
  for (let index = 0; index < seed.length; index++) dictionary[index] = seed.charCodeAt(index);
  const output = new Uint8Array(size);
  let write = seed.length;
  let position = 16;
  let length = 0;
  while (position < end && length < size) {
    const flags = bytes[position++]!;
    for (let bit = 0; bit < 8 && position < end && length < size; bit++) {
      if (flags & (1 << bit)) {
        if (position + 1 >= end) throw new Error("invalid-email");
        const token = (bytes[position++]! << 8) | bytes[position++]!;
        let read = token >> 4;
        const count = (token & 15) + 2;
        if (read === (write & 4095)) break;
        for (let index = 0; index < count && length < size; index++) {
          const byte = dictionary[read++ & 4095]!;
          output[length++] = byte;
          dictionary[write++ & 4095] = byte;
        }
      } else {
        const byte = bytes[position++]!;
        output[length++] = byte;
        dictionary[write++ & 4095] = byte;
      }
    }
  }
  if (length !== size) throw new Error("invalid-email");
  return new TextDecoder("windows-1252").decode(output);
}

export function rtfToText(rtf: string): string {
  const hidden = new Set(["fonttbl", "colortbl", "stylesheet", "info", "pict", "object", "fldinst", "header", "footer"]);
  const stack: { skip: boolean; unicodeFallback: number }[] = [];
  let state = { skip: false, unicodeFallback: 1 };
  let fallback = 0;
  let text = "";

  for (let position = 0; position < rtf.length;) {
    const char = rtf[position++]!;
    if (char === "{") {
      if (stack.length >= 80) throw new Error("email-too-large");
      stack.push({ ...state });
    } else if (char === "}") {
      state = stack.pop() ?? { skip: false, unicodeFallback: 1 };
    } else if (char === "\\") {
      const next = rtf[position]!;
      if (next === "*") { state.skip = true; position++; continue; }
      if (next === "'") {
        const byte = Number.parseInt(rtf.slice(position + 1, position + 3), 16);
        position += 3;
        if (fallback) fallback--;
        else if (!state.skip && !Number.isNaN(byte)) text += new TextDecoder("windows-1252").decode(new Uint8Array([byte]));
        continue;
      }
      if (/[^a-z]/i.test(next)) {
        position++;
        if (fallback) fallback--;
        else if (!state.skip) text += next === "~" ? "\u00a0" : ["\\", "{", "}"].includes(next) ? next : "";
        continue;
      }
      const match = /^([a-z]+)(-?\d+)? ?/i.exec(rtf.slice(position));
      if (!match) continue;
      position += match[0].length;
      const word = match[1]!.toLowerCase();
      const value = Number(match[2] ?? 0);
      if (hidden.has(word)) state.skip = true;
      if (word === "bin") { position += Math.max(0, value); continue; }
      if (word === "uc") state.unicodeFallback = Math.max(0, Math.min(10, value));
      if (state.skip) continue;
      if (word === "u") { text += String.fromCharCode(value & 65535); fallback = state.unicodeFallback; }
      else if (word === "par" || word === "line") text += "\n";
      else if (word === "tab") text += "\t";
      else if (word === "emdash") text += "—";
      else if (word === "endash") text += "–";
      else if (word === "bullet") text += "•";
    } else if (char !== "\r" && char !== "\n") {
      if (fallback) fallback--;
      else if (!state.skip) text += char;
    }
  }
  return text.trim();
}
