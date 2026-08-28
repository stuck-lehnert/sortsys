#!/usr/bin/env bun

import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { readFile } from 'node:fs/promises';
import { createClient } from '../client/src/index.ts';

type CsvRow = Record<string, string>;

async function prompt(rl: ReturnType<typeof createInterface>, question: string, defaultValue?: string) {
  const label = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
  const answer = (await rl.question(label)).trim();
  if (answer) return answer;
  if (defaultValue) return defaultValue;
  return '';
}

function parseCsv(text: string): CsvRow[] {
  const rows: string[][] = [];
  let current: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i += 1;
        continue;
      }
      if (ch === '"') {
        inQuotes = false;
        continue;
      }
      field += ch;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === ',') {
      current.push(field);
      field = '';
      continue;
    }

    if (ch === '\n') {
      current.push(field);
      field = '';
      if (current.some(value => value.length)) rows.push(current);
      current = [];
      continue;
    }

    if (ch === '\r') continue;
    field += ch;
  }

  current.push(field);
  if (current.some(value => value.length)) rows.push(current);

  if (!rows.length) return [];
  const header = rows[0]!.map(value => value.trim());
  return rows.slice(1).map(values => {
    const row: CsvRow = {};
    header.forEach((key, idx) => {
      row[key] = (values[idx] ?? '').trim();
    });
    return row;
  });
}

function parseNumber(value: string): number | null {
  const match = value.replace(/\s/g, '').match(/-?\d+(?:[.,]\d+)?/);
  if (!match) return null;
  const normalized = match[0]!.replace(',', '.');
  const num = Number(normalized);
  return Number.isFinite(num) ? num : null;
}

function parseDate(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parts = trimmed.split('-').map(part => part.trim());
  if (parts.length === 3) {
    const [month, day, year] = parts;
    const mm = Number(month);
    const dd = Number(day);
    const yy = Number(year);
    if (Number.isFinite(mm) && Number.isFinite(dd) && Number.isFinite(yy)) {
      const fullYear = yy < 100 ? 2000 + yy : yy;
      return new Date(Date.UTC(fullYear, mm - 1, dd));
    }
  }
  const fallback = new Date(trimmed);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function normalizeUnit(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeCategory(value: string): string[] {
  if (!value.trim()) return [];
  return value
    .split(';')
    .map(entry => entry.trim())
    .filter(Boolean);
}

async function main() {
  const rl = createInterface({ input, output });
  const apiHost = process.env.SORTSYS_API_HOST ?? 'https://app.sortsys.de/api/v2';

  try {
    const csvPath = await prompt(rl, 'CSV path');
    if (!csvPath) throw new Error('CSV path is required.');

    const tenant = (await prompt(rl, 'Tenant name')).toLowerCase();
    if (!tenant) throw new Error('Tenant name is required.');

    const username = (await prompt(rl, 'Username')).toLowerCase();
    if (!username) throw new Error('Username is required.');

    const password = await prompt(rl, 'Password');
    if (!password) throw new Error('Password is required.');

    const csvText = await readFile(csvPath, 'utf8');
    const rows = parseCsv(csvText);
    if (!rows.length) throw new Error('CSV contains no data rows.');

    const client = createClient(apiHost, "import-products-csv");
    await client.login({ tenant, username, password });

    const vendorCache = new Map<string, string>();
    const productCache = new Map<string, string>();

    const [nextCustomId, nextCustomErr] = await client.query('products.suggestNextCustomId', undefined);
    if (nextCustomErr) throw nextCustomErr;
    let customId = nextCustomId ?? 1;

    let createdProducts = 0;
    let createdVendors = 0;
    let createdPriceRecords = 0;

    type ProductEntry = {
      key: string;
      name: string;
      description: string | null;
      brand: string | null;
      baseUnit: string;
      otherUnits: Record<string, number>;
      categories: Set<string>;
      customId: number;
    };

    type PriceEntry = {
      productKey: string;
      vendorName: string | null;
      price: number | null;
      qty: number;
      unit: string | null;
      date: Date;
    };

    const productsByKey = new Map<string, ProductEntry>();
    const priceEntries: PriceEntry[] = [];
    const vendorNames = new Set<string>();

    for (const row of rows) {
      const name = row['Name']?.trim();
      if (!name) continue;

      const description = row['Beschreibung']?.trim() || null;
      const brand = row['Hersteller']?.trim() || null;
      const baseUnit = normalizeUnit(row['Basiseinheit'] ?? '') ?? '';
      if (!baseUnit) continue;

      const otherUnits: Record<string, number> = {};
      const unit1 = normalizeUnit(row['Einheit1'] ?? '');
      const unit2 = normalizeUnit(row['Einheit2'] ?? '');
      const conv1 = parseNumber(row['Umrechnung1'] ?? '');
      const conv2 = parseNumber(row['Umrechnung2'] ?? '');
      if (unit1 && conv1 && conv1 >= 1) otherUnits[unit1] = conv1;
      if (unit2 && conv2 && conv2 >= 1) otherUnits[unit2] = conv2;

      const key = `${name}::${brand ?? ''}::${baseUnit}`;
      let product = productsByKey.get(key);
      if (!product) {
        product = {
          key,
          name,
          description,
          brand,
          baseUnit,
          otherUnits,
          categories: new Set<string>(),
          customId,
        };
        customId += 1;
        productsByKey.set(key, product);
      }

      normalizeCategory(row['Kategorie'] ?? '').forEach(category => product!.categories.add(category));

      const vendorName = row['Händler']?.trim() || null;
      if (vendorName) vendorNames.add(vendorName);

      priceEntries.push({
        productKey: key,
        vendorName,
        price: parseNumber(row['Preis'] ?? ''),
        qty: parseNumber(row['Menge'] ?? '') ?? 1,
        unit: normalizeUnit(row['Einheit'] ?? ''),
        date: parseDate(row['Datum'] ?? '') ?? new Date(),
      });
    }

    const productEntries = [...productsByKey.values()];
    async function runBatches<T>(items: T[], handler: (item: T) => Promise<void>) {
      const batchSize = 20;
      const delayMs = 3000;

      for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        await Promise.all(batch.map(handler));
        if (i + batchSize < items.length) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    }

    await runBatches(productEntries, async entry => {
      const [searchResults, searchErr] = await client.query('products.list', { search: entry.name });
      if (searchErr) throw searchErr;

      const match = (searchResults ?? []).find(candidate =>
        candidate.name.toLowerCase() === entry.name.toLowerCase() &&
        (candidate.brand ?? '').toLowerCase() === (entry.brand ?? '').toLowerCase() &&
        candidate.baseUnit === entry.baseUnit,
      );

      let productId = match?.id;
      if (!productId) {
        const [created, createErr] = await client.mutate('products.create', {
          customId: entry.customId,
          name: entry.name,
          brand: entry.brand,
          description: entry.description,
          baseUnit: entry.baseUnit,
          otherUnits: entry.otherUnits,
        });
        if (createErr) throw createErr;
        productId = created.id;
        createdProducts += 1;
      }

      productCache.set(entry.key, productId);

      if (entry.categories.size) {
        await runBatches([...entry.categories], category =>
          client.mutate('products.categories.tag', { id: productId!, category }).then(([, err]) => {
            if (err) throw err;
          }),
        );
      }
    });

    const vendorList = [...vendorNames];
    await runBatches(vendorList, async vendorName => {
      const [vendors, vendorErr] = await client.query('products.vendors.list', { search: vendorName });
      if (vendorErr) throw vendorErr;
      const matched = (vendors ?? []).find(v => v.name.toLowerCase() === vendorName.toLowerCase());
      let vendorId = matched?.id ?? null;
      if (!vendorId) {
        const [createdVendor, vendorCreateErr] = await client.mutate('products.vendors.create', {
          name: vendorName,
          description: null,
        });
        if (vendorCreateErr) throw vendorCreateErr;
        vendorId = createdVendor.id;
        createdVendors += 1;
      }
      if (vendorId) vendorCache.set(vendorName, vendorId);
    });

    await runBatches(priceEntries, async entry => {
      if (entry.price == null) return;
      const productId = productCache.get(entry.productKey);
      if (!productId) return;

      const product = productsByKey.get(entry.productKey);
      if (!product) return;

      let pricePerBaseUnit = entry.price / entry.qty;
      if (entry.unit && entry.unit !== product.baseUnit) {
        const factor = product.otherUnits[entry.unit];
        if (factor && factor > 0) {
          pricePerBaseUnit = entry.price / (entry.qty * factor);
        }
      }

      const vendorId = entry.vendorName ? vendorCache.get(entry.vendorName) ?? null : null;
      const [_, priceErr] = await client.mutate('products.priceRecords.create', {
        productId,
        vendorId,
        pricePerBaseUnit,
        timestamp: entry.date,
        isRealPurchase: true,
        comment: null,
      });
      if (priceErr) throw priceErr;
      createdPriceRecords += 1;
    });

    console.log(`Created products: ${createdProducts}`);
    console.log(`Created vendors: ${createdVendors}`);
    console.log(`Created price records: ${createdPriceRecords}`);
  } finally {
    rl.close();
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
