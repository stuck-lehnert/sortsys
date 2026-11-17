export const scanResult = {
  documentType: "deliveryNote",
  deliveryNote: {
    supplier: "Baustoffhandel 732149",
    deliveryNumber: "LS-482173",
    deliveryDate: "2026-11-12",
    comment: null,
    records: [],
    warnings: [],
    specialRecords: [
      {
        sourceText: "12,5 m² Gipskarton",
        name: "Gipskarton",
        unit: "m²",
        amount: 12.5,
        pricePerUnit: 4.75,
        confidence: 0.95,
        comment: null,
      },
    ],
  },
  priceList: null,
};

export function oldScan(changes = {}) {
  return {
    id: "19",
    tenant_name: "old-tenant",
    user_id: "87",
    source_object_key: "original/scanned-delivery-86129.png",
    file_name: "Private Lieferung 486219.png",
    mime_type: "image/png",
    size_bytes: "100",
    source_documents: null,
    state: "completed",
    result: JSON.stringify(scanResult),
    error: null,
    created_at: "2026-11-12 10:00:00.123456+00",
    updated_at: "2026-11-12 10:00:00.123457+00",
    ...changes,
  };
}

export function scanSourceSql(rows) {
  return rows
    .map((row) => {
      const columns = Object.keys(row);
      const fields = columns.map((column) => {
        const value = row[column];
        if (value === null) return "\\N";
        return value
          .replaceAll("\\", "\\\\")
          .replaceAll("\t", "\\t")
          .replaceAll("\n", "\\n")
          .replaceAll("\r", "\\r");
      });
      return `COPY public.__delivery_note_scans (${columns.join(", ")}) FROM stdin;\n${fields.join("\t")}\n\\.\n`;
    })
    .join("\n");
}
