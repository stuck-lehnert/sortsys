import assert from "node:assert/strict";
import { createClient, RpcClientError, type Client } from "@sortsys/v2-client";
import { lockCryptoSession, signIn } from "../../app/lib/crypto/session";
import { createBusinessClient } from "../../app/lib/data/businessClient";
import { required } from "../../app/lib/data/protectedObjects";
import { duckDriver } from "../../app/lib/data/testing/duckDriver.mjs";

assert.equal(process.env.SORTSYS_DISPOSABLE_AUTH_TEST, "1");
assert.equal(process.env.SORTSYS_AUTH_E2E_OPERATOR_PASSWORD, undefined);

const {
  SORTSYS_AUTH_E2E_API: endpoint,
  SORTSYS_AUTH_E2E_USERNAME: login,
  SORTSYS_AUTH_E2E_PASSWORD: password,
} = process.env;
assert.ok(endpoint && login && password);

const api = new URL(endpoint);
assert.equal(api.protocol, "http:");
assert.equal(api.hostname, "127.0.0.1");
assert.equal(api.href, `${api.origin}/`);

const [username, tenant, extra] = login.split("@");
assert.ok(username && tenant && extra === undefined);
const credentials = { tenant, username, password };
const realtime = process.env.SORTSYS_AUTH_E2E_SCENARIO === "project-events-api";

const OriginalSocket = globalThis.WebSocket;
if (realtime) {
  globalThis.WebSocket = class ObservedSocket extends OriginalSocket {
    constructor(...args: ConstructorParameters<typeof OriginalSocket>) {
      super(...args);

      const start = performance.now();
      const report = (phase: string) => {
        const elapsed = Math.round(performance.now() - start);
        console.log(`Project event channel: ${phase} (${elapsed} ms)`);
      };
      this.addEventListener("open", () => report("open"));
      this.addEventListener("close", () => report("closed"));
      this.addEventListener("error", () => report("socket error"));

      this.addEventListener("message", ({ data }) => {
        if (typeof data !== "string") return;

        try {
          const phase: unknown = JSON.parse(data)?.type;
          if (phase === "challenge" || phase === "ready" || phase === "revoked") {
            report(phase);
          }
        } catch {
          report("invalid frame");
        }
      });
    }
  };
}

function observe(client: Client): Client {
  async function measure<T extends [unknown, Error | null]>(
    path: string,
    call: () => Promise<T>,
  ): Promise<T> {
    const started = performance.now();
    console.log(`Project API: ${path} started`);

    const result = await call();
    const error = result[1];
    let outcome = error ? "failed" : "ok";
    if (error instanceof RpcClientError && error.code) outcome = error.code;
    const elapsed = Math.round(performance.now() - started);
    console.log(`Project API: ${path} ${outcome} (${elapsed} ms)`);

    return result;
  }

  return {
    ...client,
    query: (path, input, options) => measure(path, () => client.query(path, input, options)),
    mutate: (path, input, options) => measure(path, () => client.mutate(path, input, options)),
  };
}

async function withOwner<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const transport = observe(createClient(api.href, "native-project-test"));
  const business = createBusinessClient(transport, {
    productDriver: duckDriver,
    endpoint: api.href,
    realtime,
  });

  try {
    await signIn(transport, credentials);
    return await run(business);
  } finally {
    business.dispose();
    await lockCryptoSession();
    transport.setToken(null);
  }
}

const title = "Werkstatt Süd – API-Prüfung";
const contactLabel = "Bauleitung";
const { id, contactId } = await withOwner(async (client) => {
  const { id: contactId } = await required(
    client.mutate("contacts.create", { lastName: "Werkstatt Süd" }),
  );

  const rejectedTitle = "Projekt mit fehlendem Ansprechpartner";
  const [, invalid] = await client.mutate("projects.create", {
    title: rejectedTitle,
    contacts: [{ contactId: "7vvvvvvvvvvvv" }],
  });
  assert.ok(invalid);
  const rejected = await required(client.query("projects.list", { search: rejectedTitle }));
  assert.deepEqual(rejected, []);

  const created = await required(client.mutate("projects.create", {
    title,
    contacts: [{ contactId, label: contactLabel }],
  }));

  return { id: created.id, contactId };
});
assert.match(id, /^[0-9a-v]+$/);

await withOwner(async (client) => {
  const project = await required(
    client.query("projects.get", { id }, { strategy: "network-only" }),
  );
  assert.equal(project.id, id);
  assert.equal(project.title, title);

  const contacts = await required(
    client.query("projects.contacts.list", { projectId: id }, { strategy: "network-only" }),
  );
  assert.deepEqual(contacts.map(({ id, label }) => ({ id, label })), [
    { id: contactId, label: contactLabel },
  ]);
});

console.log("Project API: direct creation with a contact and readback after a fresh sign-in verified");
