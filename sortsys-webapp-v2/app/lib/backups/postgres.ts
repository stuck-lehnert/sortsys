import { uiText } from "~/lib/i18n";
/** Reads the SQL/Gzip backups emitted by the previous system. SQL is treated
 * as a file format; no statement from the backup is ever executed. */
export type PostgresBackupRow = {
  schema: string;
  table: string;
  columns: readonly string[];
  values: (string | null)[];
};
export class InvalidPostgresBackup extends Error {
  constructor(
    message = uiText(
      "Die PostgreSQL-Sicherung konnte nicht gelesen werden.",
      "The PostgreSQL backup could not be read.",
    ),
  ) {
    super(message);
    this.name = "InvalidPostgresBackup";
  }
}
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const IDENTIFIER = '(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)';
const COPY = new RegExp(
  `^\\s*COPY\\s+(${IDENTIFIER})(?:\\s*\\.\\s*(${IDENTIFIER}))?\\s*\\(([^]*)\\)\\s+FROM\\s+stdin\\s*;\\s*$`,
  "i",
);

function name(value: string): string {
  if (value.startsWith('"')) return value.slice(1, -1).replaceAll('""', '"');
  return value.toLowerCase();
}
function columns(value: string): string[] {
  const parts = value.match(new RegExp(IDENTIFIER, "g"));
  if (!parts?.length || parts.length > 10_000)
    throw new InvalidPostgresBackup();
  let remaining = value;
  const result = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    remaining = remaining.trimStart();
    if (!remaining.startsWith(part)) throw new InvalidPostgresBackup();
    remaining = remaining.slice(part.length).trimStart();
    if (index < parts.length - 1) {
      if (!remaining.startsWith(",")) throw new InvalidPostgresBackup();
      remaining = remaining.slice(1);
    }
    result.push(name(part));
  }
  if (remaining.trim() || new Set(result).size !== result.length)
    throw new InvalidPostgresBackup();
  return result;
}
function copyHeader(value: string) {
  const matched = COPY.exec(value);
  if (!matched)
    throw new InvalidPostgresBackup(
      uiText(
        "Die Sicherung enthält ein nicht unterstütztes COPY-Format.",
        "The backup contains an unsupported COPY format.",
      ),
    );
  const schema = matched[2] ? name(matched[1]!) : "public";
  const table = name(matched[2] ?? matched[1]!);
  return { schema, table, columns: columns(matched[3]!) };
}

/** COPY escapes describe bytes, so octal/hex UTF-8 sequences are decoded
 * together rather than turning e.g. an umlaut into two unrelated characters. */
export function copyText(value: string): string | null {
  if (value === "\\N") return null;
  if (!value.includes("\\")) {
    if (value.includes("\0")) throw new InvalidPostgresBackup();
    return value;
  }
  const output = new Uint8Array(encoder.encode(value).length);
  const escapes: Record<string, number> = {
    b: 8,
    f: 12,
    n: 10,
    r: 13,
    t: 9,
    v: 11,
  };
  let size = 0;
  let cursor = 0;
  function append(text: string) {
    const encoded = encoder.encode(text);
    output.set(encoded, size);
    size += encoded.length;
  }
  while (cursor < value.length) {
    const slash = value.indexOf("\\", cursor);
    const end = slash < 0 ? value.length : slash;
    append(value.slice(cursor, end));
    if (slash < 0) break;
    cursor = slash + 1;
    if (cursor === value.length) throw new InvalidPostgresBackup();
    const escape = value[cursor++]!;
    if (Object.hasOwn(escapes, escape)) output[size++] = escapes[escape]!;
    else if (/[0-7]/.test(escape)) {
      let octal = escape;
      while (octal.length < 3 && /[0-7]/.test(value[cursor] ?? "x"))
        octal += value[cursor++];
      const byte = Number.parseInt(octal, 8);
      if (byte > 255) throw new InvalidPostgresBackup();
      output[size++] = byte;
    } else if (escape === "x") {
      const hex = /^[0-9a-f]{1,2}/i.exec(value.slice(cursor));
      if (!hex) throw new InvalidPostgresBackup();
      output[size++] = Number.parseInt(hex[0], 16);
      cursor += hex[0].length;
    } else {
      const character = String.fromCodePoint(value.codePointAt(slash + 1)!);
      append(character);
      cursor = slash + 1 + character.length;
    }
  }
  try {
    const decoded = output.subarray(0, size);
    if (decoded.includes(0)) throw new InvalidPostgresBackup();
    return decoder.decode(decoded);
  } catch {
    throw new InvalidPostgresBackup();
  }
}

class SqlBoundary {
  private quote = "";
  private escaped = false;
  private comments = 0;
  private statement = false;
  get idle(): boolean {
    return !this.quote && !this.comments && !this.statement;
  }
  feed(line: string): void {
    let index = 0;
    while (index < line.length) {
      const character = line[index]!;
      if (this.quote.startsWith("$")) {
        const end = line.indexOf(this.quote, index);
        if (end < 0) return;
        index = end + this.quote.length;
        this.quote = "";
      } else if (this.quote) {
        if (this.escaped && character === "\\") index += 2;
        else if (character === this.quote) {
          if (line[index + 1] === this.quote) index += 2;
          else {
            this.quote = "";
            index++;
          }
        } else index++;
      } else if (this.comments) {
        if (line.startsWith("/*", index)) {
          this.comments++;
          index += 2;
        } else if (line.startsWith("*/", index)) {
          this.comments--;
          index += 2;
        } else index++;
      } else if (line.startsWith("--", index)) return;
      else if (line.startsWith("/*", index)) {
        this.comments++;
        index += 2;
      } else if (/\s/.test(character)) index++;
      else if (character === ";") {
        this.statement = false;
        index++;
      } else {
        this.statement = true;
        if (character === "'" || character === '"') {
          this.quote = character;
          this.escaped =
            character === "'" &&
            /[eE]/.test(line[index - 1] ?? "") &&
            !/[A-Za-z0-9_$]/.test(line[index - 2] ?? "");
          index++;
        } else if (
          character === "$" &&
          /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.test(line.slice(index))
        ) {
          this.quote = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(
            line.slice(index),
          )![0];
          index += this.quote.length;
        } else index++;
      }
    }
  }
}
async function* lines(
  stream: ReadableStream<Uint8Array<ArrayBuffer>>,
  signal: AbortSignal | undefined,
  maximum: number,
): AsyncGenerator<string> {
  const reader = stream
    .pipeThrough(new TextDecoderStream("utf-8", { fatal: true }))
    .getReader();
  let parts: string[] = [];
  let size = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const next = await reader.read();
      signal?.throwIfAborted();
      if (next.done) break;
      const fragments = next.value.split("\n");
      for (let index = 0; index < fragments.length; index++) {
        const fragment = fragments[index]!;
        size += encoder.encode(fragment).length;
        if (size > maximum)
          throw new InvalidPostgresBackup(
            uiText(
              "Eine Zeile der Sicherung überschreitet die zulässige Größe.",
              "A backup row exceeds the permitted size.",
            ),
          );
        parts.push(fragment);
        if (index < fragments.length - 1) {
          yield parts.join("").replace(/\r$/, "");
          parts = [];
          size = 0;
        }
      }
    }
    if (parts.some(Boolean)) yield parts.join("").replace(/\r$/, "");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function* readPostgresBackup(
  file: Blob,
  options: {
    signal?: AbortSignal;
    maxRowBytes?: number;
    acceptTable?(schema: string, table: string): boolean;
  } = {},
): AsyncGenerator<PostgresBackupRow> {
  options.signal?.throwIfAborted();
  const prefix = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  if (String.fromCharCode(...prefix) === "PGDMP")
    throw new InvalidPostgresBackup(
      uiText(
        "Benötigt wird eine SQL- oder SQL.GZ-Sicherung.",
        "A SQL or SQL.GZ backup is required.",
      ),
    );
  const gzip = prefix[0] === 0x1f && prefix[1] === 0x8b;
  let stream: ReadableStream<Uint8Array<ArrayBuffer>> = file.stream();
  if (gzip) stream = stream.pipeThrough(new DecompressionStream("gzip"));
  const boundary = new SqlBoundary();
  let header: string[] | null = null;
  let copy: ReturnType<typeof copyHeader> | null = null;
  let included = false;
  for await (const line of lines(
    stream,
    options.signal,
    options.maxRowBytes ?? 32 * 1024 * 1024,
  )) {
    if (copy) {
      if (line === "\\.") {
        copy = null;
        continue;
      }
      if (!included) continue;
      const fields = line.split("\t");
      if (fields.length !== copy.columns.length)
        throw new InvalidPostgresBackup();
      yield { ...copy, values: fields.map(copyText) };
      continue;
    }
    if (boundary.idle && /^\\/.test(line)) {
      if (/^\\(?:un)?restrict(?:\s|$)/.test(line)) continue;
      throw new InvalidPostgresBackup(
        uiText(
          "Die Sicherung enthält nicht unterstützte psql-Anweisungen.",
          "The backup contains unsupported psql commands.",
        ),
      );
    }
    if (boundary.idle && /^\s*COPY\b/i.test(line)) header = [];
    if (header) {
      header.push(line);
      if (header.join("\n").length > 64 * 1024)
        throw new InvalidPostgresBackup();
    }
    boundary.feed(line);
    if (header && boundary.idle) {
      copy = copyHeader(header.join("\n"));
      included = options.acceptTable?.(copy.schema, copy.table) ?? true;
      header = null;
    }
  }
  if (copy || header || !boundary.idle)
    throw new InvalidPostgresBackup(
      uiText("Die Sicherung ist unvollständig.", "The backup is incomplete."),
    );
}
