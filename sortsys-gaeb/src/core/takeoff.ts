import { decimalString, roundedDivide } from "./decimal";

export const MEASURE_SHAPES = [
  "count",
  "length",
  "area",
  "volume",
  "triangle",
  "trapezoid",
  "factor",
  "formula",
] as const;
export type MeasureShape = (typeof MEASURE_SHAPES)[number];
export type MeasureMode = "add" | "deduct" | "opening";
export type Measurement = {
  id: string;
  shape: MeasureShape;
  mode: MeasureMode;
  location: string;
  label: string;
  count: string;
  a: string;
  b: string;
  c: string;
  factor: string;
  expression: string;
  /** Empty means always deduct. The limit applies to one opening, before count. */
  threshold: string;
};
export type MeasureProperty = Exclude<keyof Measurement, "id">;
export type Fraction = { n: bigint; d: bigint };
const ZERO: Fraction = { n: 0n, d: 1n };
function fraction(n: bigint, d = 1n): Fraction {
  if (!d) throw new Error("takeoff-division-zero");
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  let a = n < 0n ? -n : n,
    b = d;
  while (b) [a, b] = [b, a % b];
  n /= a || 1n;
  d /= a || 1n;
  if (n.toString().length > 100 || d.toString().length > 100)
    throw new Error("takeoff-expression");
  return { n, d };
}
export const addMeasures = (a: Fraction, b: Fraction) =>
  fraction(a.n * b.d + b.n * a.d, a.d * b.d);
const multiply = (a: Fraction, b: Fraction) => fraction(a.n * b.n, a.d * b.d);
export function measurementResult(
  row: Measurement,
  roundEach = false,
): Fraction {
  const result = calculateMeasurement(row).result;
  return roundEach ? evaluateMeasure(measureDecimal(result)) : result;
}
export function measureDecimal(value: Fraction, scale = 3): string {
  return decimalString(
    roundedDivide(value.n * 10n ** BigInt(scale), value.d),
    scale,
  );
}
export function normalizeMeasureExpression(input: string): string {
  return input
    .trim()
    .replace(/,/g, ".")
    .replace(/[×xX]/g, "*")
    .replace(/−/g, "-")
    .replace(/\s+/g, "");
}
/** Bounded arithmetic parser; no JS evaluation, identifiers or implicit units. */
export function evaluateMeasure(input: string): Fraction {
  const value = normalizeMeasureExpression(input);
  if (!value || value.length > 256 || /[^\d.()+\-*/]/.test(value))
    throw new Error("takeoff-expression");
  const tokens = value.match(/\d+(?:\.\d*)?|\.\d+|[()+\-*/]/g) ?? [];
  if (tokens.join("") !== value || tokens.length > 128)
    throw new Error("takeoff-expression");
  let at = 0,
    depth = 0;
  const primary = (): Fraction => {
    if (++depth > 24) throw new Error("takeoff-expression");
    const token = tokens[at++];
    let result: Fraction;
    if (token === "+" || token === "-") {
      result = primary();
      if (token === "-") result = { ...result, n: -result.n };
    } else if (token === "(") {
      result = sum();
      if (tokens[at++] !== ")") throw new Error("takeoff-expression");
    } else if (token && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(token)) {
      const [whole = "0", part = ""] = token.split(".");
      if (whole.length > 12 || part.length > 12)
        throw new Error("takeoff-expression");
      result = fraction(
        BigInt((whole || "0") + part),
        10n ** BigInt(part.length),
      );
    } else throw new Error("takeoff-expression");
    depth--;
    return result;
  };
  const product = (): Fraction => {
    let result = primary();
    while (["*", "/"].includes(tokens[at] ?? "")) {
      const op = tokens[at++],
        right = primary();
      result = multiply(
        result,
        op === "*" ? right : fraction(right.d, right.n),
      );
    }
    return result;
  };
  const sum = (): Fraction => {
    let result = product();
    while (["+", "-"].includes(tokens[at] ?? "")) {
      const op = tokens[at++],
        right = product();
      result = addMeasures(
        result,
        op === "+" ? right : { ...right, n: -right.n },
      );
    }
    return result;
  };
  const result = sum();
  if (at !== tokens.length) throw new Error("takeoff-expression");
  return result;
}
export function defaultMeasureShape(unit: string): MeasureShape {
  if (/^(m[³3]|cbm)$/i.test(unit)) return "volume";
  if (/^(m[²2]|qm)$/i.test(unit)) return "area";
  if (/^(m|lfm|lf\.m|cm|mm)$/i.test(unit)) return "length";
  return "count";
}
export function newMeasurement(
  shape: MeasureShape,
  id: string = crypto.randomUUID(),
): Measurement {
  return {
    id,
    shape,
    mode: "add",
    location: "",
    label: "",
    count: "1",
    a: "0",
    b: "0",
    c: "0",
    factor: "0.67",
    expression: "0",
    threshold: "",
  };
}
export function measureProperties(
  shape: MeasureShape,
): Array<"a" | "b" | "c" | "factor" | "expression"> {
  switch (shape) {
    case "count":
      return [];
    case "length":
      return ["a"];
    case "area":
    case "triangle":
      return ["a", "b"];
    case "volume":
    case "trapezoid":
      return ["a", "b", "c"];
    case "factor":
      return ["a", "b", "factor"];
    case "formula":
      return ["expression"];
  }
}
function operand(value: string): string {
  const normalized = normalizeMeasureExpression(value);
  const n = evaluateMeasure(normalized);
  if (n.n < 0n) throw new Error("takeoff-negative-dimension");
  return /^[\d.]+$/.test(normalized) ? normalized : `(${normalized})`;
}
export function calculateMeasurement(row: Measurement) {
  const count = operand(row.count);
  const a = () => operand(row.a),
    b = () => operand(row.b),
    c = () => operand(row.c);
  let single: string;
  switch (row.shape) {
    case "count":
      single = "1";
      break;
    case "length":
      single = a();
      break;
    case "area":
      single = `${a()}*${b()}`;
      break;
    case "volume":
      single = `${a()}*${b()}*${c()}`;
      break;
    case "triangle":
      single = `${a()}*${b()}/2`;
      break;
    case "trapezoid":
      single = `(${a()}+${b()})*${c()}/2`;
      break;
    case "factor":
      single = `${a()}*${b()}*${operand(row.factor)}`;
      break;
    case "formula":
      single = normalizeMeasureExpression(row.expression);
      evaluateMeasure(single);
      break;
  }
  const singleValue = evaluateMeasure(single);
  const measured = multiply(singleValue, evaluateMeasure(count));
  const area = ["area", "triangle", "trapezoid", "factor"].includes(row.shape);
  if (row.mode === "opening" && !area) throw new Error("takeoff-opening-area");
  const limit = row.threshold ? evaluateMeasure(operand(row.threshold)) : null;
  const overmeasured =
    row.mode === "opening" &&
    !!limit &&
    singleValue.n >= 0n &&
    singleValue.n * limit.d <= limit.n * singleValue.d;
  const expression =
    row.shape === "count"
      ? count
      : count === "1"
        ? single
        : `${count}*(${single})`;
  const signed =
    row.mode === "add" ? measured : { ...measured, n: -measured.n };
  return {
    single: singleValue,
    measured,
    result: overmeasured ? ZERO : signed,
    overmeasured,
    baseExpression: expression,
    expression: overmeasured
      ? `0*(${expression})`
      : row.mode === "add"
        ? expression
        : `-(${expression})`,
  };
}

export const MEASURE_MARKER = "sortsys:measure:v1:";
export const MEASURE_BASE_MARKER = "sortsys:measure-base:v1:";
export function measurementComment(row: Measurement): string {
  return `<!--${MEASURE_MARKER}${encodeURIComponent(JSON.stringify(row)).replace(/-/g, "%2D")}-->`;
}
export function readMeasurement(element: Element): Measurement | undefined {
  const comment = [...element.childNodes].find(
    (node) =>
      node.nodeType === 8 && node.textContent?.startsWith(MEASURE_MARKER),
  );
  if (!comment) return;
  try {
    const row = JSON.parse(
      decodeURIComponent(comment.textContent!.slice(MEASURE_MARKER.length)),
    );
    if (
      !row ||
      Object.keys(newMeasurement("count", "test")).some(
        (key) => typeof row[key] !== "string",
      ) ||
      !/^[\w-]{1,80}$/.test(row.id) ||
      !MEASURE_SHAPES.includes(row.shape) ||
      !["add", "deduct", "opening"].includes(row.mode)
    )
      return;
    return row as Measurement;
  } catch {
    return;
  }
}
/** GAEB 3.3 §7.2.2 example: 11 blanks, 2 flags, explanation(9), factor(7), FN(2), values(38), address(6), reserved(5). */
export function rebMeasureRow(row: Measurement, address: string): string {
  const calculation = calculateMeasurement(row);
  let expression = calculation.expression;
  if (expression.length > 37) {
    // A long user expression stays in the metadata; an exact rational remains
    // executable by every FN91 reader. Never round individual measures here.
    expression =
      calculation.result.d === 1n
        ? String(calculation.result.n)
        : `${calculation.result.n}/${calculation.result.d}`;
  }
  if (expression.length > 37 || !/^\d{4}[A-Z]\d$/.test(address))
    throw new Error("takeoff-reb-capacity");
  const explanation = Array.from(row.label || row.location)
    .slice(0, 9)
    .map((char) => (char.length === 1 ? char : "?"))
    .join("")
    .replace(/[\r\n\t]/g, " ")
    .padEnd(9);
  return (
    " ".repeat(13) +
    explanation +
    "   1000" +
    "91" +
    `${expression}=`.padEnd(38) +
    address +
    " ".repeat(5)
  );
}
export function rebAddress(index: number): string {
  if (index < 0 || index >= 9999 * 26 * 10)
    throw new Error("takeoff-reb-capacity");
  return (
    String(Math.floor(index / 260) + 1).padStart(4, "0") +
    String.fromCharCode(65 + (Math.floor(index / 10) % 26)) +
    String(index % 10)
  );
}
export function rebResult(row: string): Fraction | undefined {
  if (row.length !== 80) return;
  if (row[11] === "*" || row[12] === "*" || !row.trim()) return ZERO;
  if (row.slice(29, 31) !== "91" || row.slice(11, 13).trim()) return;
  const values = row.slice(31, 69).trim();
  if (!values.endsWith("=")) return;
  const factor = row.slice(22, 29).trim();
  if (factor && !/^[+-]?\d+$/.test(factor)) return;
  try {
    return multiply(
      evaluateMeasure(values.slice(0, -1)),
      factor ? fraction(BigInt(factor), 1000n) : { n: 1n, d: 1n },
    );
  } catch {
    return;
  }
}
export type TakeoffState = {
  rows: Array<{ value: Measurement; element: Element }>;
  headings: Array<{ value: TakeoffHeading; element: Element }>;
  content: Array<{ kind: "measure" | "heading"; id: string; element: Element }>;
  roundEach: boolean;
  unmanaged: Element[];
  baseline: Fraction;
  total: Fraction;
  mismatch: boolean;
  metadataValid: boolean;
};
const states = new WeakMap<Element, TakeoffState>();
export function readTakeoff(
  item: Element,
  namespace: string,
  quantity: string,
): TakeoffState {
  const cached = states.get(item);
  if (cached) return cached;
  const rows: TakeoffState["rows"] = [],
    unmanaged: Element[] = [];
  const roundEach = [
    ...item.ownerDocument.getElementsByTagNameNS(
      namespace,
      "MethodDescription",
    ),
  ].some((element) => element.textContent?.includes("1979"));
  const headings: TakeoffState["headings"] = [],
    content: TakeoffState["content"] = [];
  const ids = new Set<string>();
  let managed = ZERO,
    invalid = false;
  for (const element of item.getElementsByTagNameNS(namespace, "QDetermItem")) {
    let value = readMeasurement(element);
    const native =
      element
        .getElementsByTagNameNS(namespace, "QTakeoff")[0]
        ?.getAttribute("Row") ?? "";
    const heading = readTakeoffHeading(element);
    if (heading) {
      if (
        ids.has(heading.id) ||
        headingRebRow(heading, native.slice(69, 75)) !== native
      ) {
        unmanaged.push(element);
        invalid = true;
        continue;
      }
      ids.add(heading.id);
      headings.push({ value: heading, element });
      content.push({ kind: "heading", id: heading.id, element });
      continue;
    }
    const annotated = !!value;
    if (
      !value &&
      native.slice(29, 31) === "91" &&
      /^\d{4}[A-Z]\d$/.test(native.slice(69, 75)) &&
      rebResult(native)
    ) {
      const factor = native.slice(22, 29).trim();
      const expression = native.slice(31, 69).trim().slice(0, -1);
      value = {
        ...newMeasurement("formula", `reb_${native.slice(69, 75)}`),
        label: native.slice(13, 22).trim(),
        expression:
          factor && factor !== "1000"
            ? `(${factor}/1000)*(${expression})`
            : expression,
      };
    }
    try {
      if (
        !value ||
        ids.has(value.id) ||
        (annotated && rebMeasureRow(value, native.slice(69, 75)) !== native)
      ) {
        unmanaged.push(element);
        invalid ||= !!value;
        continue;
      }
      ids.add(value.id);
      managed = addMeasures(managed, measurementResult(value, roundEach));
      rows.push({ value, element });
      content.push({ kind: "measure", id: value.id, element });
    } catch {
      unmanaged.push(element);
      invalid = true;
    }
  }
  const parent = [...item.children].find(
    (node) => node.namespaceURI === namespace && node.localName === "QtyDeterm",
  );
  const baseComment =
    parent &&
    [...parent.childNodes].find(
      (node) =>
        node.nodeType === 8 &&
        node.textContent?.startsWith(MEASURE_BASE_MARKER),
    );
  const stored = evaluateMeasure(quantity || "0");
  let baseline = ZERO;
  if (baseComment) {
    try {
      baseline = evaluateMeasure(
        baseComment.textContent!.slice(MEASURE_BASE_MARKER.length),
      );
    } catch {
      invalid = true;
    }
  } else if (!rows.length) baseline = stored;
  else if (unmanaged.length)
    baseline = addMeasures(stored, { ...managed, n: -managed.n });
  const total = addMeasures(baseline, managed);
  const state = {
    rows,
    headings,
    content,
    roundEach,
    unmanaged,
    baseline,
    total,
    metadataValid: !invalid,
    mismatch:
      invalid ||
      (!!rows.length && measureDecimal(total) !== measureDecimal(stored)),
  };
  states.set(item, state);
  return state;
}

/** Decimal display keeps all supplied precision and pads to three places. */
export function measurementInput(value: string, locale: "de" | "en"): string {
  const normalized = normalizeMeasureExpression(value);
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) {
    const sign = normalized.startsWith("-") ? "-" : "";
    const [whole, part = ""] = normalized.replace(/^[+-]/, "").split(".");
    return `${sign}${(whole || "0").replace(/^0+(?=\d)/, "")}${locale === "de" ? "," : "."}${part.padEnd(3, "0")}`;
  }
  return locale === "de" ? value.replace(/\./g, ",") : value.replace(/,/g, ".");
}

export function measureShapesForUnit(
  unit: string,
  current?: MeasureShape,
): MeasureShape[] {
  const normalized = unit.trim().toLocaleLowerCase("de-DE");
  const shapes: MeasureShape[] = /^(m|lfm|lf\.m|cm|mm)$/.test(normalized)
    ? ["length", "formula", "count"]
    : /^(m[²2]|qm)$/.test(normalized)
      ? ["area", "triangle", "trapezoid", "factor", "volume", "formula"]
      : /^(m[³3]|cbm)$/.test(normalized)
        ? ["volume", "formula", "count"]
        : /^(stk|st|pcs|psch|h|std)$/.test(normalized)
          ? ["count", "formula"]
          : [...MEASURE_SHAPES];
  if (current && !shapes.includes(current)) shapes.push(current);
  return shapes;
}

export type TakeoffHeading = { id: string; title: string };
export const HEADING_MARKER = "sortsys:takeoff-heading:v1:";
export function headingComment(heading: TakeoffHeading): string {
  return `<!--${HEADING_MARKER}${encodeURIComponent(JSON.stringify(heading)).replace(/-/g, "%2D")}-->`;
}
export function headingRebRow(
  heading: TakeoffHeading,
  address: string,
): string {
  const title = Array.from(heading.title)
    .map((char) => (char.length === 1 && !/[\r\n\t]/.test(char) ? char : " "))
    .slice(0, 56)
    .join("");
  return " ".repeat(11) + "* " + title.padEnd(56) + address + " ".repeat(5);
}
export function readTakeoffHeading(
  element: Element,
): TakeoffHeading | undefined {
  const marker = [...element.childNodes].find(
    (node) =>
      node.nodeType === 8 && node.textContent?.startsWith(HEADING_MARKER),
  );
  if (!marker) return;
  try {
    const value = JSON.parse(
      decodeURIComponent(marker.textContent!.slice(HEADING_MARKER.length)),
    );
    if (
      typeof value.title === "string" &&
      typeof value.id === "string" &&
      /^[\w-]{1,80}$/.test(value.id)
    )
      return value;
  } catch {
    /* Retain an unknown extension untouched. */
  }
}
