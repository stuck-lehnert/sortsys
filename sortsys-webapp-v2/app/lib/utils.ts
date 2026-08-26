import type { Address, Product } from "~/type-helpers";
import { formatAddress } from "./format";

export function forever() {
  return new Promise(() => { });
}

export function isEmptyNode(node?: React.ReactNode | null): boolean {
  if (node === null || node === undefined || node === false) return true;
  if (typeof node === 'string') return !node.trim();
  if (Array.isArray(node)) return node.every(isEmptyNode);
  return false;
}

export function chooseRandom<T>(arr: T[]) {
  return arr[Math.floor(Math.random() * arr.length)];
}


export function generateId(length: number = 10) {
  const choosable = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.split('');

  let result = '';
  for (let i = 0; i < length; i++) result += chooseRandom(choosable);
  return result;
}

export function isJson(str: string): boolean {
  try {
    JSON.parse(str);
    return true;
  } catch (_) {
    return false;
  }
}

export function formatJson(str: string): string {
  return JSON.stringify(JSON.parse(str), null, 4);
}

export function parseFloatCustom(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return NaN;
  return parseFloat(`${value}`.replace(',', '.'));
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function openBlob(blob: Blob, targetWindow?: Window | null) {
  const url = URL.createObjectURL(blob);
  if (targetWindow && !targetWindow.closed) {
    targetWindow.location.href = url;
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return;
  }

  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export type BlobTarget = 'download' | 'open';

export function deliverBlob(blob: Blob, filename: string, target: BlobTarget = 'open', targetWindow?: Window | null) {
  if (target === 'open') {
    openBlob(blob, targetWindow);
    return;
  }

  downloadBlob(blob, filename);
}

export function addressUrl(address: Address) {
  return `https://www.google.com/maps/search/${encodeURIComponent(formatAddress(address))}`;
}

export function startOfDay(date: Date) {
  const newDate = new Date(date);
  newDate.setHours(0, 0, 0, 0);
  return newDate;
}

export function endOfDay(date: Date) {
  const newDate = new Date(date);
  newDate.setHours(23, 59, 59, 999);
  return newDate;
}

export function upmatchUnit(product: Product, inBaseUnits: number): [number, string] {
  if (!product || !inBaseUnits || isNaN(inBaseUnits)) {
    return [inBaseUnits, product?.baseUnit ?? ''];
  }

  const entries = Object.entries(product.otherUnits ?? {})
    .filter(([, value]) => value > 0 && value <= inBaseUnits)
    .sort((a, b) => b[1] - a[1]);

  for (const [unit, value] of entries) {
    const ratio = inBaseUnits / value;
    const roundedToQuarter = Math.round(ratio * 4) / 4;
    if (Math.abs(ratio - roundedToQuarter) < 1e-6) {
      return [roundedToQuarter, unit];
    }
  }

  return [inBaseUnits, product.baseUnit];
}
