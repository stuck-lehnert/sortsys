function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function prepareProposalInput(value: unknown, field = ""): unknown {
  // The client revives dates from persisted proposal JSON before review.
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (
    field === "effectiveAt" &&
    typeof value === "string" &&
    value.toLowerCase() === "now"
  ) {
    return new Date().toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((entry) => prepareProposalInput(entry));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([nestedField, nestedValue]) => [
        nestedField,
        prepareProposalInput(nestedValue, nestedField),
      ]),
    );
  }

  return value;
}
