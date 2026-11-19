import { afterEach, expect, test } from "bun:test";
import { RpcClientError } from "@sortsys/v2-client";
import { lockCryptoSession } from "../crypto/session";
import { protectedCollections } from "./protectedObjects";
import { protectedTenant } from "./testing/protectedTenant.mjs";
import { isKeyEnvelopeQuery } from "./testing/keyQueries.mjs";
import { defineDataModel } from "./runtime/model";
import { DataRuntime } from "./runtime/runtime";
import { encryptedDataStorage } from "./runtime/storage";
import { InvalidProtectedData, signPolicy } from "@sortsys/zerotrust/sortsys";

afterEach(() => lockCryptoSession());

const area = {
  domain: "catalog:products:master-data",
  scope: "catalog:products",
  facet: "master-data",
  prefix: "product:",
};
const metadataPaths = new Set(["zerotrust.access.snapshot"]);

const metadataModel = defineDataModel({
  name: "selected-metadata-test",
  decode: (value) => value,
  sources: () => [],
  tables: [],
});

test("a denied bundled read fails closed without probing a separate path", async () => {
  const fixture = await protectedTenant([area]);
  for (const [code, status] of [["FORBIDDEN", 403], ["NOT_FOUND", 404]]) {
    const calls = [];
    const client = {
      ...fixture.client,
      async query(path, input) {
        calls.push(path);
        expect(input.pages.selections).toHaveLength(1);
        return [
          null,
          new RpcClientError({
            message: "Denied protected selection",
            code: -32000,
            data: { code, httpCode: status },
          }),
        ];
      },
    };
    const runtime = new DataRuntime(encryptedDataStorage(client), () => {});
    try {
      await expect(
        runtime.read([{ model: metadataModel, area }], () => {
          throw new Error("A denied view must not reach the business callback");
        }),
      ).rejects.toBeInstanceOf(InvalidProtectedData);
      expect(calls).toEqual(["zerotrust.access.snapshot"]);
    } finally {
      await runtime.close();
    }
  }
});

function metadataRequests(count) {
  return Array.from({ length: count }, (_, index) => {
    const scope = `testing:entries${index + 1}`;
    return {
      model: metadataModel,
      area: {
        domain: `${scope}:master-data`,
        scope,
        facet: "master-data",
        prefix: `${scope}:`,
      },
    };
  });
}

test("small runtime reads select new and retained areas and discard a revoked retained area", async () => {
  const requests = metadataRequests(3);
  const [first, second, third] = requests;
  const fixture = await protectedTenant(
    requests.map((request) => request.area),
  );
  for (const [index, request] of requests.entries()) {
    await fixture.seed(request.area, `${request.area.prefix}1`, {
      title: `Private entry ${index + 1}`,
    });
  }
  fixture.calls.length = 0;
  const runtime = new DataRuntime(
    encryptedDataStorage(fixture.client),
    () => {},
  );
  const values = (view, request) =>
    view.documents(request).map((document) => document.value.title);
  try {
    expect(await runtime.read([first], (view) => values(view, first))).toEqual([
      "Private entry 1",
    ]);
    expect(
      await runtime.read([second], (view) => [
        values(view, first),
        values(view, second),
      ]),
    ).toEqual([["Private entry 1"], ["Private entry 2"]]);
    const inputs = fixture.calls
      .filter((call) => metadataPaths.has(call.path))
      .map((call) => call.input);
    expect(inputs.map((input) => input.domains)).toEqual([
      [first.area.domain],
      [second.area.domain, first.area.domain],
    ]);
    expect(
      inputs.map((input) =>
        input.pages.selections.map((selection) => selection.domain),
      ),
    ).toEqual([[first.area.domain], [second.area.domain]]);
    const finalChecks = fixture.calls
      .filter((call) => call.path === "zerotrust.objects.pages")
      .flatMap((call) => call.input.selections);
    expect(finalChecks).toMatchObject([
      { domain: first.area.domain, headOnly: true, snapshot: "1" },
      { domain: second.area.domain, headOnly: true, snapshot: "1" },
    ]);

    const [previous] = await fixture.client.query("zerotrust.policy.get");
    const { signature, ...unsigned } = previous;
    const policy = await signPolicy(
      {
        ...unsigned,
        version: "3",
        rules: unsigned.rules.filter((rule) => rule.scope !== first.area.scope),
      },
      fixture.authorityKey.privateKey,
    );
    const query = fixture.client.query;
    fixture.client.query = (path, input, options) => {
      if (path === "zerotrust.policy.get")
        return Promise.resolve([policy, null]);
      return query(path, input, options);
    };
    await runtime.read([third], (view) => {
      expect(() => view.documents(first)).toThrow();
      expect(values(view, second)).toEqual(["Private entry 2"]);
      expect(values(view, third)).toEqual(["Private entry 3"]);
    });
    const last = fixture.calls
      .filter((call) => metadataPaths.has(call.path))
      .at(-1);
    expect(last.input.domains).toEqual([
      third.area.domain,
      first.area.domain,
      second.area.domain,
    ]);
  } finally {
    await runtime.close();
  }
});

test("runtime selections beyond the server limit use the complete verified inventory", async () => {
  const requests = metadataRequests(17);
  const fixture = await protectedTenant(
    requests.map((request) => request.area),
  );
  const runtime = new DataRuntime(
    encryptedDataStorage(fixture.client),
    () => {},
  );
  try {
    await runtime.read(requests.slice(0, 16), (view) => {
      for (const request of requests.slice(0, 16))
        expect(view.documents(request)).toEqual([]);
    });
    await runtime.read([requests[16]], (view) => {
      for (const request of requests)
        expect(view.documents(request)).toEqual([]);
    });
    const inputs = fixture.calls
      .filter((call) => metadataPaths.has(call.path))
      .map((call) => call.input);
    expect(inputs[0].domains).toHaveLength(16);
    expect(inputs[1].domains).toBeUndefined();
  } finally {
    await runtime.close();
  }
});

test("a business read reuses verified metadata while still checking encrypted objects and account lifetime", async () => {
  const entries = {
    domain: "testing:entries:master-data",
    scope: "testing:entries",
    facet: "master-data",
    prefix: "entry:",
  };
  const fixture = await protectedTenant([entries]);
  const context = await protectedCollections(
    fixture.client,
    new AbortController().signal,
  );
  const collection = context(entries);
  try {
    await collection.read();
    await collection.write([
      await collection.packet("entry:1", { title: "Geprüfter Inhalt" }),
    ]);
  } finally {
    collection.close();
  }
  const model = defineDataModel({
    name: "verified-context-test",
    decode: (value) => value,
    sources: () => [],
    tables: [],
  });
  const request = { model, area: entries };
  const runtime = new DataRuntime(
    encryptedDataStorage(fixture.client),
    () => {},
  );
  const metadataCount = () =>
    fixture.calls.filter((call) => metadataPaths.has(call.path)).length;
  const before = metadataCount();
  try {
    const documents = await runtime.read(
      [request],
      (view) => view.documents(request),
      context,
    );
    expect(documents.map((document) => document.value)).toEqual([
      { title: "Geprüfter Inhalt" },
    ]);
    expect(metadataCount()).toBe(before);
    expect(
      fixture.calls.some((call) => call.path === "zerotrust.objects.list"),
    ).toBe(true);
    runtime.revalidate();
    await lockCryptoSession();
    await expect(
      runtime.read([request], (view) => view.documents(request), context),
    ).rejects.toThrow();
  } finally {
    await runtime.close();
  }
});

async function heldMetadata() {
  const fixture = await protectedTenant([area]);
  const query = fixture.client.query;
  const started = new Set();
  let release;
  let allStarted;
  const response = new Promise((resolve) => {
    release = resolve;
  });
  const ready = new Promise((resolve) => {
    allStarted = resolve;
  });
  fixture.client.query = async (path, input) => {
    if (metadataPaths.has(path)) {
      started.add(path);
      if (started.size === metadataPaths.size) allStarted();
      await response;
    }
    return query(path, input);
  };
  return { ...fixture, ready, release, started };
}

test("one combined metadata response produces no usable context before verification", async () => {
  const fixture = await heldMetadata();
  let opened = false;
  const pending = protectedCollections(
    fixture.client,
    new AbortController().signal,
  ).then((context) => {
    opened = true;
    return context;
  });
  await fixture.ready;
  expect(opened).toBe(false);
  expect(fixture.started).toEqual(metadataPaths);
  fixture.release();
  const context = await pending;
  expect(
    context.areas((domain) => (domain === area.domain ? area : null)),
  ).toEqual([area]);
  expect(fixture.calls.some((call) => isKeyEnvelopeQuery(call.path))).toBe(
    false,
  );
});

test("account replacement during concurrent metadata loading cannot return a late access context", async () => {
  const fixture = await heldMetadata();
  const pending = protectedCollections(
    fixture.client,
    new AbortController().signal,
  );
  await fixture.ready;
  await lockCryptoSession();
  fixture.release();
  await expect(pending).rejects.toThrow();
  expect(
    fixture.calls.some(
      (call) =>
        isKeyEnvelopeQuery(call.path) ||
        call.path.startsWith("zerotrust.objects."),
    ),
  ).toBe(false);
});

test("selected inventories reject unrelated or duplicate domains before requesting content keys", async () => {
  const fixture = await protectedTenant([area]);
  const query = fixture.client.query;
  let substitution;
  fixture.client.query = async (path, input) => {
    const result = await query(path, input);
    if (path !== "zerotrust.access.snapshot" || result[1]) return result;
    const value = structuredClone(result[0]);
    if (substitution === "duplicate") {
      value.domains.push(value.domains[0]);
    } else if (substitution === "foreign") {
      value.domains.push({
        ...value.domains[0],
        id: "testing:foreign:master-data",
      });
    }
    return [value, null];
  };
  const signal = new AbortController().signal;
  const valid = await protectedCollections(fixture.client, signal, [
    area.domain,
  ]);
  expect(valid.readable(area)).toBe(true);
  for (substitution of ["duplicate", "foreign"]) {
    await expect(
      protectedCollections(fixture.client, signal, [area.domain]),
    ).rejects.toThrow();
  }
  expect(fixture.calls.some((call) => isKeyEnvelopeQuery(call.path))).toBe(
    false,
  );
});
