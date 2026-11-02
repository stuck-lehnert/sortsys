import { describe, expect, test } from "bun:test";
import { prepareProposalInput } from "./llmProposalInput";

describe("proposal operation inputs", () => {
  test("serializes the revived order-received date as RFC3339", () => {
    const orderReceivedAt = new Date("2026-10-31T09:30:00.000Z");
    const input = { title: "Dummy-Testprojekt", orderReceivedAt };

    expect(prepareProposalInput(input)).toEqual({
      title: "Dummy-Testprojekt",
      orderReceivedAt: "2026-10-31T09:30:00.000Z",
    });
    expect(input.orderReceivedAt).toBe(orderReceivedAt);
    expect(input.orderReceivedAt.toISOString()).toBe(
      "2026-10-31T09:30:00.000Z",
    );
  });

  test("preserves instants and dates nested in objects and arrays", () => {
    const instant = new Date("2026-10-31T14:45:00+02:00");
    const input = {
      dates: [instant, { timestamp: instant }],
      nested: { day: instant, effectiveAt: instant },
    };

    expect(prepareProposalInput(input)).toEqual({
      dates: [
        "2026-10-31T12:45:00.000Z",
        { timestamp: "2026-10-31T12:45:00.000Z" },
      ],
      nested: {
        day: "2026-10-31T12:45:00.000Z",
        effectiveAt: "2026-10-31T12:45:00.000Z",
      },
    });
    expect(input.dates[0]).toBe(instant);
    expect(input.nested.day).toBe(instant);
  });

  test("serializes a date input directly", () => {
    expect(prepareProposalInput(new Date("2026-10-31T00:00:00Z"))).toBe(
      "2026-10-31T00:00:00.000Z",
    );
  });

  test("rejects an invalid date before a mutation can receive an empty map", () => {
    expect(() =>
      prepareProposalInput({ orderReceivedAt: new Date(Number.NaN) }),
    ).toThrow(RangeError);
  });

  test("keeps optional values, primitive fields and date-only strings intact", () => {
    const input = {
      title: "Dummy-Testprojekt",
      customerId: null,
      projectLeaderUserId: null,
      address: null,
      day: "2026-10-31",
      enabled: false,
      count: 0,
      items: [],
      metadata: {},
    };

    expect(prepareProposalInput(input)).toEqual(input);
    expect(prepareProposalInput(undefined)).toBeUndefined();
  });

  test("keeps the existing effectiveAt now shortcut scoped to that field", () => {
    const before = Date.now();
    const result = prepareProposalInput({ effectiveAt: "NOW", title: "now" });

    expect(result.title).toBe("now");
    expect(Date.parse(result.effectiveAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(result.effectiveAt)).toBeLessThanOrEqual(Date.now());
    expect(result.effectiveAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
