import { escapeXml } from "./document";
import { createGaebXml } from "./templates";
import { MAX_GAEB_BYTES } from "./types";
import { decimal as scaledDecimal, decimalString, itemAmount } from "./decimal";

// Fixed-width records and GAEB 2000 objects follow the examples published in
// BVBS / MWM's "Das Freie GAEB Buch", sections 1.4, 1.5 and 3.1/3.2.
// The original bytes are retained, including fields this reader cannot project.
type Entry = {
  kind: "group" | "item";
  oz: string;
  title: string;
  description: string;
  qty?: string;
  price?: string;
  amount?: string;
  unit: string;
  flags?: string;
  indexValue?: string;
  children: Entry[];
};
type Legacy = {
  phase: "83" | "84" | "85" | "86" | "87";
  title: string;
  project: string;
  currency: string;
  lengths: number[];
  index: number;
  entries: Entry[];
};
const fail = (): never => {
  throw new Error("legacy-gaeb-structure");
};
const node = (kind: Entry["kind"], oz: string): Entry => ({
  kind,
  oz,
  title: "",
  description: "",
  unit: "",
  children: [],
});
function legacyPhase(value: string): Legacy["phase"] {
  if (!["83", "84", "85", "86", "87"].includes(value))
    throw new Error("legacy-gaeb-phase");
  return value as Legacy["phase"];
}
function price(value: string, scale: number, implied = false): string | undefined {
  value = value.trim().replace(/,/g, ".");
  if (!value) return undefined;
  if (implied) {
    if (!/^-?\d{1,13}$/.test(value)) return fail();
    return decimalString(BigInt(value), scale);
  }
  if (!new RegExp(`^-?\\d{1,13}(?:\\.\\d{0,${scale}})?$`).test(value)) return fail();
  return decimalString(scaledDecimal(value.replace(/\.$/, ""), scale), scale);
}
const decimal = (value: string, implied = false) => {
  value = value.trim().replace(/,/g, ".");
  if (!value) return "0.000";
  if (implied) {
    if (!/^\d{1,11}$/.test(value)) return fail();
    return `${BigInt(value) / 1000n}.${(BigInt(value) % 1000n).toString().padStart(3, "0")}`;
  }
  if (!/^\d{1,12}(?:\.\d{0,3})?$/.test(value)) return fail();
  const [whole, part = ""] = value.split(".");
  return `${BigInt(whole)}.${part.padEnd(3, "0")}`;
};
function gaeb90(text: string): Legacy {
  const lines = text
    .replace(/\u001a+$/, "")
    .split(/\r\n|\n|\r/)
    .filter((line) => line.trim());
  if (
    lines.length > 250000 ||
    lines.some(
      (line) =>
        line.length !== 80 ||
        !/^(?:\d{2}|T[019])/.test(line) ||
        !/^\d{6}$/.test(line.slice(74)),
    )
  )
    return fail();
  const header = lines.find((line) => line.startsWith("00"));
  if (!header) return fail();
  const phase = legacyPhase(header.slice(10, 12));
  const mask = header.slice(62, 71).trim().replace(/0+$/, "");
  if (!/^(?:1+)?(?:2+)?(?:3+)?(?:4+)?P+I?$/.test(mask)) return fail();
  const levels = mask.match(/1+|2+|3+|4+|P+/g)!;
  const output: Legacy = {
    phase,
    title: "",
    project: "",
    currency: "EUR",
    lengths: levels.map((p) => p.length),
    index: mask.endsWith("I") ? 1 : 0,
    entries: [],
  };
  const groups = new Map<string, Entry>();
  const positions = new Map<string, Entry>();
  let current: Entry | undefined;
  const path = (raw: string, group: boolean) => {
    const parts: string[] = [];
    let offset = 0;
    for (const length of output.lengths) {
      parts.push(raw.slice(offset, offset + length).trim());
      offset += length;
    }
    if (group) while (parts.at(-1) === "") parts.pop();
    if (!parts.length || parts.some((part) => !/^\d+$/.test(part)))
      return fail();
    return parts;
  };
  const parent = (parts: string[]) => {
    let children = output.entries;
    for (let i = 0; i < parts.length; i++) {
      const key = parts.slice(0, i + 1).join(".");
      let entry = groups.get(key);
      if (!entry) {
        entry = node("group", parts[i]);
        children.push(entry);
        groups.set(key, entry);
      }
      children = entry.children;
    }
    return children;
  };
  for (const line of lines) {
    const type = line.slice(0, 2);
    if (type === "01") output.title = line.slice(2, 42).trim();
    else if (type === "02") output.project = line.slice(2, 62).trim();
    else if (type === "08") output.currency = line.slice(2, 6).trim();
    else if (type === "11") {
      const parts = path(line.slice(2, 11), true);
      parent(parts);
      current = groups.get(parts.join("."));
    } else if (type === "12" && current?.kind === "group")
      current.title += (current.title ? " " : "") + line.slice(2, 72).trim();
    else if (type === "21") {
      const raw = line.slice(2, 11);
      const parts = path(raw, false);
      current = node("item", parts.at(-1)!);
      current.indexValue = output.index
        ? raw.slice(output.lengths.reduce((a, b) => a + b, 0)).trim()
        : "";
      current.qty = decimal(line.slice(23, 34), true);
      current.unit = line.slice(34, 38).trim();
      current.flags = line.slice(11, 14);
      parent(parts.slice(0, -1)).push(current);
      positions.set(raw, current);
    } else if (type === "22" || type === "23") {
      const raw = line.slice(2, 11);
      current = positions.get(raw);
      if (!current) {
        const parts = path(raw, false);
        current = node("item", parts.at(-1)!);
        current.indexValue = output.index
          ? raw.slice(output.lengths.reduce((a, b) => a + b, 0)).trim()
          : "";
        positions.set(raw, current);
        parent(parts.slice(0, -1)).push(current);
      }
      current.price = price(line.slice(12, 23), 3, true);
      current.amount = price(line.slice(24, 36), 2, true);
    } else if (type === "25" && current?.kind === "item")
      current.title += (current.title ? " " : "") + line.slice(2, 72).trim();
    else if (type === "26" && current)
      current.description +=
        (current.description ? "\n" : "") + line.slice(5, 60).trimEnd();
    else if (["31", "33", "99"].includes(type)) current = undefined;
  }
  return output;
}
type ObjectNode = {
  name: string;
  values: Map<string, string>;
  children: ObjectNode[];
};
function objects(text: string): ObjectNode {
  const root: ObjectNode = { name: "root", values: new Map(), children: [] };
  const stack = [root];
  const token =
    /#(begin|end)\[([^\]\r\n]+)\]|\[([^\]\r\n]+)\]([\s\S]*?)\[end\]/gi;
  let last = 0,
    count = 0;
  for (const match of text.matchAll(token)) {
    if (text.slice(last, match.index).trim() || ++count > 250000) return fail();
    last = match.index! + match[0].length;
    if (match[1]?.toLowerCase() === "begin") {
      if (stack.length >= 32) return fail();
      const next: ObjectNode = {
        name: match[2],
        values: new Map(),
        children: [],
      };
      stack.at(-1)!.children.push(next);
      stack.push(next);
    } else if (match[1]) {
      if (
        stack.length === 1 ||
        stack.pop()!.name.toLowerCase() !== match[2].toLowerCase()
      )
        return fail();
    } else stack.at(-1)!.values.set(match[3].toLowerCase(), match[4]);
  }
  if (text.slice(last).trim() || stack.length !== 1) return fail();
  return root;
}
/** Bounded RTF text projection. Raw RTF remains in the retained source. */
function rtf(input: string): string {
  if (!/^\s*\{\\rtf/.test(input)) return input.trim();
  let result = "",
    skip = false,
    fallback = 1,
    remaining = 0;
  const stack: Array<{ skip: boolean; fallback: number }> = [];
  const tokens =
    input.match(
      /\\'[0-9a-fA-F]{2}|\\[a-zA-Z]+-?\d* ?|\\[^a-zA-Z]|[{}]|[^\\{}]+/g,
    ) ?? [];
  if (tokens.length > 100000) return fail();
  for (const token of tokens) {
    if (token === "{") {
      if (stack.length >= 64) return fail();
      stack.push({ skip, fallback });
    } else if (token === "}") {
      const previous = stack.pop();
      if (previous) {
        skip = previous.skip;
        fallback = previous.fallback;
      }
    } else if (token.startsWith("\\")) {
      const cmd = /^\\([a-zA-Z]+)(-?\d+)?/.exec(token);
      if (cmd) {
        const name = cmd[1].toLowerCase();
        if (
          [
            "fonttbl",
            "colortbl",
            "stylesheet",
            "info",
            "pict",
            "object",
            "fldinst",
          ].includes(name)
        )
          skip = true;
        if (skip) continue;
        if (name === "uc")
          fallback = Math.max(0, Math.min(16, Number(cmd[2] ?? 1)));
        else if (name === "u") {
          result += String.fromCharCode((Number(cmd[2]) + 65536) % 65536);
          remaining = fallback;
        } else if (["par", "line"].includes(name)) result += "\n";
        else if (name === "tab") result += "\t";
      } else if (!skip) {
        let char =
          token[1] === "'"
            ? new TextDecoder("windows-1252").decode(
                Uint8Array.of(parseInt(token.slice(2), 16)),
              )
            : token[1] === "~"
              ? " "
              : token[1] === "_"
                ? "-"
                : /[\\{}]/.test(token[1])
                  ? token[1]
                  : "";
        if (token[1] === "*") {
          skip = true;
          continue;
        }
        if (remaining) remaining--;
        else result += char;
      }
    } else if (!skip) {
      const chunk = token.replace(/[\r\n]/g, "");
      result += chunk.slice(remaining);
      remaining = Math.max(0, remaining - chunk.length);
    }
  }
  return result.trim();
}
function gaeb2000(text: string): Legacy {
  const root = objects(text);
  const gaeb = root.children.find((n) => n.name.toLowerCase() === "gaeb");
  const child = (n: ObjectNode | undefined, name: string) =>
    n?.children.find((c) => c.name.toLowerCase() === name.toLowerCase());
  const value = (n: ObjectNode | undefined, name: string) =>
    n?.values.get(name.toLowerCase())?.trim() ?? "";
  const award = child(gaeb, "Vergabe"),
    lv = child(award, "LV"),
    info = child(lv, "LVInfo");
  if (!gaeb || !award || !lv || !info) return fail();
  const phase = legacyPhase(value(award, "DP"));
  const breakdown = info.children.filter(
    (c) => c.name.toLowerCase() === "lvglied",
  );
  const lengths = breakdown
    .filter((c) => value(c, "Typ") !== "Index")
    .map((c) => Number(value(c, "Laenge")));
  if (
    !lengths.length ||
    lengths.length > 6 ||
    lengths.some((n) => !Number.isInteger(n) || n < 1 || n > 14) ||
    lengths.reduce((a, b) => a + b, 0) > 14
  )
    return fail();
  const project = child(gaeb, "PrjInfo");
  const output: Legacy = {
    phase,
    title: value(info, "Bez") || value(info, "Name"),
    project: value(project, "Bez") || value(project, "Name"),
    currency: value(child(award, "VergabeInfo"), "Wae") || "EUR",
    lengths,
    index: breakdown.some((c) => value(c, "Typ") === "Index") ? 1 : 0,
    entries: [],
  };
  const entries = (container: ObjectNode, level: number): Entry[] => {
    if (level > 6) return fail();
    return container.children
      .filter((c) => ["lvbereich", "position"].includes(c.name.toLowerCase()))
      .map((c) => {
        const isGroup = c.name.toLowerCase() === "lvbereich",
          raw = value(c, "OZ");
        const offset = lengths.slice(0, level).reduce((a, b) => a + b, 0);
        const part = raw.slice(offset, offset + lengths[level]);
        if (!part || !/^[\da-zA-Z]+$/.test(part)) return fail();
        const result = node(isGroup ? "group" : "item", part);
        if (!isGroup && output.index)
          result.indexValue = raw.slice(offset + lengths[level]).trim();
        const description = child(c, "Beschreibung");
        result.title = rtf(
          isGroup ? value(c, "Bez") : value(description, "Kurztext"),
        );
        result.description = rtf(value(description, "Langtext"));
        if (isGroup) result.children = entries(c, level + 1);
        else {
          const quantity = value(c, "Menge");
          result.qty = quantity ? decimal(quantity) : phase === "84" ? undefined : "0.000";
          result.unit = value(c, "ME");
          result.price = price(value(c, "EP"), 3);
          result.amount = price(value(c, "GB"), 2);
        }
        return result;
      });
  };
  output.entries = entries(lv, 0);
  return output;
}
function project(input: Legacy, bytes: Uint8Array, fileName: string, phase = input.phase): string {
  if (!["EUR", "EURO"].includes(input.currency.toUpperCase()))
    throw new Error("workflow-currency");
  let next = 0,
    items = 0;
  const text = (value: string) =>
    value
      .split(/\r\n|\n|\r/)
      .map((line) => `<p><span>${escapeXml(line)}</span></p>`)
      .join("");
  const total = (nodes: Entry[]): bigint => nodes.reduce((sum, entry) =>
    sum + (entry.kind === "group" ? total(entry.children) : entry.flags?.[1] === "E" ? 0n : scaledDecimal(
      entry.amount ?? (entry.qty !== undefined && entry.price !== undefined ? itemAmount(entry.qty, entry.price) : "0"), 2,
    )), 0n);
  const entries = (nodes: Entry[]): string => {
    let body = "",
      inItems = false;
    for (const entry of nodes) {
      const id = `legacy-${++next}`;
      if (entry.kind === "group") {
        if (inItems) {
          body += "</Itemlist>";
          inItems = false;
        }
        body += `<BoQCtgy ID="${id}" RNoPart="${escapeXml(entry.oz)}">${phase === "84" ? "" : `<LblTx><p><span style="font-weight:bold">${escapeXml(entry.title)}</span></p>${entry.description ? text(entry.description) : ""}</LblTx>`}<BoQBody>${entries(entry.children)}</BoQBody>${phase === "83" ? "" : `<Totals><Total>${decimalString(total(entry.children), 2)}</Total></Totals>`}</BoQCtgy>`;
      } else {
        items++;
        if (!inItems) {
          body += "<Itemlist>";
          inItems = true;
        }
        const index = entry.indexValue ?? "";
        const part = entry.oz;
        const flags = entry.flags ?? "NNN";
        if (!/^[N ][NEM ][N ]$/.test(flags))
          throw new Error("legacy-gaeb-pricing");
        if (phase === "84" && /[EM]/.test(flags)) throw new Error("legacy-gaeb-pricing");
        if (phase !== "83" && entry.price === undefined) throw new Error("legacy-gaeb-pricing");
        const amount = entry.amount ?? (entry.qty !== undefined && entry.price !== undefined ? itemAmount(entry.qty, entry.price) : undefined);
        body += `<Item ID="${id}" RNoPart="${escapeXml(part)}"${index ? ` RNoIndex="${escapeXml(index)}"` : ""}>${phase !== "84" && (flags[1] === "E" || flags[1] === "M") ? `<Provis>${flags[1] === "E" ? "WithoutTotal" : "WithTotal"}</Provis>` : ""}${entry.qty === undefined ? "" : `<Qty>${entry.qty}</Qty>`}${phase === "84" ? "" : `<QU>${escapeXml(entry.unit)}</QU>`}${phase === "83" ? "" : `<UP>${entry.price}</UP>${amount === undefined ? "" : `<IT>${amount}</IT>`}`}${phase === "84" ? "" : `<Description><CompleteText><DetailTxt><Text>${text(entry.description)}</Text></DetailTxt><OutlineText><OutlTxt><TextOutlTxt><p><span style="font-weight:bold">${escapeXml(entry.title)}</span></p></TextOutlTxt></OutlTxt></OutlineText></CompleteText></Description>`}</Item>`;
      }
    }
    return body + (inItems ? "</Itemlist>" : "");
  };
  const body = entries(input.entries);
  if (!items) return fail();
  const bkdn =
    input.lengths
      .map(
        (length, index) =>
          `<BoQBkdn><Type>${index === input.lengths.length - 1 ? "Item" : "BoQLevel"}</Type><Length>${length}</Length><Num>Yes</Num></BoQBkdn>`,
      )
      .join("") +
    (input.index
      ? "<BoQBkdn><Type>Index</Type><Length>1</Length><Num>No</Num></BoQBkdn>"
      : "");
  let base = createGaebXml(phase, input.title || fileName);
  base = base
    .replace(/<BoQBkdn>[\s\S]*?<\/BoQBkdn>/, bkdn)
    .replace("<BoQBody/>", `<BoQBody>${body}</BoQBody>`);
  if (phase !== "83") {
    const allAmountsKnown = (nodes: Entry[]): boolean => nodes.every((entry) => entry.kind === "group"
      ? allAmountsKnown(entry.children)
      : entry.amount !== undefined || (entry.qty !== undefined && entry.price !== undefined));
    if (allAmountsKnown(input.entries))
      base = base.replace("</BoQInfo>", `<Totals><Total>${decimalString(total(input.entries), 2)}</Total></Totals></BoQInfo>`);
  }
  if (input.project)
    base = base.replace(
      "<Award>",
      `<PrjInfo><NamePrj>${escapeXml(input.project.slice(0, 60))}</NamePrj></PrjInfo><Award>`,
    );
  let raw = "";
  for (let i = 0; i < bytes.length; i += 8192)
    raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
  base = base.replace(
    "</GAEB>",
    `<!--sortsys:legacy-source:v1:${encodeURIComponent(fileName).replace(/-/g, "%2D")}:${btoa(raw)}--></GAEB>`,
  );
  if (new TextEncoder().encode(base).byteLength > MAX_GAEB_BYTES)
    throw new Error("document-too-large");
  return base;
}
// DOS files commonly use CP850; undefined Windows-1252 control bytes are a
// strong signal, while GAEB 2000 may declare its OEM charset explicitly.
const CP850 =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´\xad±‗¾¶§÷¸°¨·¹³²■\xa0";
export function readGaebInput(
  bytes: Uint8Array,
  fileName: string,
): { xml: string; fileName: string; format: "xml" | "gaeb90" | "gaeb2000"; referenceXml?: string } {
  if (bytes.length > MAX_GAEB_BYTES) throw new Error("document-too-large");
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    source = new TextDecoder("windows-1252").decode(bytes);
    if (
      /\[Zeichensatz\]\s*(?:OEM|DOS|CP850)/i.test(source) ||
      (!/^\s*</.test(source) && /[\u0081\u008d\u008f\u0090\u009d]/.test(source))
    ) {
      source = "";
      for (let offset = 0; offset < bytes.length; offset += 8192)
        source += Array.from(bytes.subarray(offset, offset + 8192), (byte) =>
          byte < 128 ? String.fromCharCode(byte) : CP850[byte - 128],
        ).join("");
    }
  }
  if (/^\s*</.test(source)) {
    // Native GAEB XML keeps its bytes/structure; declarations do not trigger conversion.
    return {
      xml: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes,
      ),
      fileName,
      format: "xml",
    };
  }
  const format = /^\s*#begin\[GAEB\]/i.test(source) ? "gaeb2000" : "gaeb90";
  const parsed =
    format === "gaeb90"
      ? gaeb90(source.replace(/^\uFEFF/, ""))
      : gaeb2000(source.replace(/^\uFEFF/, ""));
  const hasScope = (entries: Entry[]): boolean => entries.every((entry) => entry.kind === "group"
    ? hasScope(entry.children)
    : entry.qty !== undefined && !!entry.unit);
  return {
    xml: project(parsed, bytes, fileName),
    fileName: fileName.replace(/\.(?:[dpx]8[3-7]|xml)$/i, "") + `.x${parsed.phase}`,
    format,
    referenceXml: parsed.phase === "84" && hasScope(parsed.entries) ? project(parsed, bytes, fileName, "83") : undefined,
  };
}
