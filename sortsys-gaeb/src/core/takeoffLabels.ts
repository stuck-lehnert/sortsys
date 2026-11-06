import {
  measurementInput,
  type Measurement,
  type MeasureProperty,
  type MeasureShape,
} from "./takeoff";
import { text, type GaebLocale } from "../messages";
export function measureShapeName(
  shape: MeasureShape,
  locale: GaebLocale,
): string {
  const labels: Record<MeasureShape, [string, string]> = {
    count: ["Stück / Anzahl", "Count"],
    length: ["Länge / Fuge", "Length / joint"],
    area: ["Rechteckfläche", "Rectangle"],
    volume: ["Drei Dimensionen", "Three dimensions"],
    triangle: ["Dreieck", "Triangle"],
    trapezoid: ["Trapez", "Trapezoid"],
    factor: ["Bogen / Formfaktor", "Arch / shape factor"],
    formula: ["Freie Formel", "Custom formula"],
  };
  return text(locale, ...labels[shape]);
}
export function measurePropertyName(
  name: MeasureProperty,
  shape: MeasureShape,
  locale: GaebLocale,
): string {
  const labels: Partial<Record<MeasureProperty, [string, string]>> = {
    location: ["Ort / Raum", "Location / room"],
    label: ["Bezeichnung", "Description"],
    count: ["Anzahl", "Count"],
    factor: ["Formfaktor", "Shape factor"],
    expression: ["Formel", "Formula"],
    a:
      shape === "factor"
        ? ["Stichhöhe", "Rise"]
        : shape === "trapezoid"
          ? ["Seite a", "Side a"]
          : ["Länge", "Length"],
    b:
      shape === "trapezoid"
        ? ["Seite b", "Side b"]
        : shape === "factor"
          ? ["Spannweite", "Span"]
          : ["Höhe / Breite", "Height / width"],
    c:
      shape === "trapezoid"
        ? ["Höhe", "Height"]
        : ["Tiefe / Faktor", "Depth / factor"],
  };
  return labels[name] ? text(locale, ...labels[name]!) : name;
}
export function measurementKey(
  entryKey: string,
  id: string,
  name: MeasureProperty,
): string {
  return `${entryKey}:measure:${id}:${name}`;
}
export function measurementField(
  key: string,
  entryKey: string,
): { id: string; name: MeasureProperty } | undefined {
  if (!key.startsWith(`${entryKey}:measure:`)) return;
  const [id, name] = key.slice(entryKey.length + 9).split(":");
  if (id && name) return { id, name: name as MeasureProperty };
}
export function formatMeasureExpression(
  expression: string,
  locale: GaebLocale,
): string {
  return (
    locale === "de" ? expression.replace(/\./g, ",") : expression
  ).replace(/\*/g, " × ");
}
export function measureModeName(
  mode: Measurement["mode"],
  locale: GaebLocale,
): string {
  return mode === "add"
    ? "+"
    : mode === "opening"
      ? text(locale, "Öffnung (−)", "Opening (−)")
      : "−";
}

/** Limits use at least two decimal places without dropping supplied precision. */
export function formatMeasureLimit(value: string, locale: GaebLocale): string {
  return measurementInput(value, locale).replace(/([.,]\d{2,}?)0+$/, "$1");
}
