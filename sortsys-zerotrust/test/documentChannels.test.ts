import { expect, test } from "bun:test";
import nativeDocument from "../../sortsys-api-v2/rust-api/tests/fixtures/zerotrust-document.json";
import nativeChannels from "../../sortsys-api-v2/rust-api/tests/fixtures/zerotrust-live-channels.json";
import {
  CREATION_FACETS,
  documentChannel,
  documentChannelKeys,
  documentChannelOuter,
  documentHead,
  documentPartTarget,
} from "../src/sortsys";

function documentWithPrices() {
  const head = structuredClone(nativeDocument.head);
  const scope = head.parts[0]!;
  const price = {
    ...scope,
    facet: "offer-prices",
    object: scope.object.replace(":scope:", ":offer-prices:"),
    keys: [{ facet: "offer-prices", generation: "4" }],
  };
  return documentHead({ ...head, parts: [price, scope] });
}

test("known content channels require only their own key; opaque content requires all keys", () => {
  const scope = documentChannel({
    scope: "commercial:2",
    document: "3",
    facet: "scope",
  });
  expect(documentChannelKeys(scope)).toEqual(["scope"]);
  expect(documentChannelOuter(scope)).toBe("scope");
  const prices = documentChannel({ ...scope, facet: "offer-prices" });
  expect(documentChannelKeys(prices)).toEqual(["offer-prices"]);
  expect(documentChannelOuter(prices)).toBe("offer-prices");
  const opaque = documentChannel({ ...scope, facet: "opaque" });
  expect(documentChannelKeys(opaque)).toEqual(CREATION_FACETS.commercial);
  expect(documentChannelOuter(opaque)).toBe("scope");
  const file = documentChannel({
    scope: "project:2",
    document: "3",
    facet: "attachment",
  });
  expect(documentChannelKeys(file)).toEqual(["attachment"]);
});

test("channels reject missing facets, noncanonical IDs, unrelated scopes and project content grants", () => {
  const channel = { scope: "commercial:2", document: "3", facet: "scope" };
  for (const invalid of [
    { scope: channel.scope, document: channel.document },
    { ...channel, facet: "master-data" },
    { ...channel, facet: "" },
    { ...channel, scope: "commercial:02" },
    { ...channel, scope: "personnel:2" },
    { ...channel, scope: "project:2" },
    { ...channel, document: "03" },
    { ...channel, extra: true },
  ]) {
    expect(() => documentChannel(invalid)).toThrow();
  }
});

test("part receipts survive header changes and edits to another content part", async () => {
  const head = documentWithPrices();
  const scopeTarget = await documentPartTarget(head, "scope");
  const altered = documentHead({
    ...head,
    version: "8",
    modifiedMicros: "1794309134123456",
    readOnly: true,
    locked: true,
  });
  expect(await documentPartTarget(altered, "scope")).toBe(scopeTarget);
  const pricePart = head.parts.find((part) => part.facet !== "scope");
  expect(pricePart).toBeDefined();
  const changedPrice = structuredClone(head);
  changedPrice.parts.find((part) => part.facet === pricePart!.facet)!.hash =
    "A".repeat(43);
  expect(await documentPartTarget(changedPrice, "scope")).toBe(scopeTarget);
  expect(await documentPartTarget(changedPrice, pricePart!.facet)).not.toBe(
    await documentPartTarget(head, pricePart!.facet),
  );
});

test("receipt targets bind tenant, document, facet, absence and the exact encryption keys", async () => {
  const head = documentWithPrices();
  const target = await documentPartTarget(head, "scope");
  const anotherTenant = { ...head, tenant: "another-tenant" };
  expect(await documentPartTarget(anotherTenant, "scope")).not.toBe(target);
  const scope = head.parts.find((part) => part.facet === "scope")!;
  const changedKeys = structuredClone(head);
  changedKeys.parts.find(
    (part) => part.facet === "scope",
  )!.keys[0]!.generation = "5";
  expect(await documentPartTarget(changedKeys, "scope")).not.toBe(target);
  const missing = {
    ...head,
    parts: head.parts.filter((part) => part.facet !== "scope"),
  };
  expect(() => documentHead(missing)).toThrow();
  const absentFacet = "measurement";
  expect(head.parts.some((part) => part.facet === absentFacet)).toBe(false);
  expect(await documentPartTarget(head, absentFacet)).not.toBe(
    await documentPartTarget(head, "attachment"),
  );
  const missingPrices = { ...head, parts: [scope] };
  expect(await documentPartTarget(missingPrices, "offer-prices")).not.toBe(
    await documentPartTarget(head, "offer-prices"),
  );
});

test("native and browser targets use the same framed part identity", async () => {
  const head = documentHead(nativeDocument.head);
  for (const facet of ["scope", "billing", "opaque"] as const) {
    expect(await documentPartTarget(head, facet)).toBe(
      nativeChannels.targets[facet],
    );
  }
});
