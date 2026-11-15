import assert from "node:assert/strict";
import type { Client } from "@sortsys/v2-client";
import { base64 } from "@sortsys/zerotrust/sortsys";
import type { OwnerDraft } from "../app/lib/crypto/tenantSetup";
import {
  initializeTenant,
  verifyTenantInitialized,
} from "../app/lib/crypto/initializeTenant";
import { duckDriver } from "../app/lib/data/testing/duckDriver.mjs";
import { required } from "../app/lib/data/protectedObjects";
import { createContentAccess } from "../app/lib/data/menuAccess";

type RequestHook = (
  url: URL,
  next: () => Promise<Response>,
) => Promise<Response>;

export async function exerciseTenantInitialization(
  owner: Client,
  peer: Client,
  draft: OwnerDraft,
  setRequestHook: (hook: RequestHook | null) => void,
) {
  const signal = new AbortController().signal;
  const before = await required(
    owner.query("zerotrust.status", undefined, { strategy: "network-only" }),
  );
  assert.equal(before.initialization, null);
  assert.equal(before.canInitialize, true);
  assert.ok(
    (await required(owner.query("auth.sessionInfo", undefined))).roles.includes(
      ":admin",
    ),
  );
  await assert.rejects(() =>
    required(
      peer.mutate("zerotrust.setup.complete", {
        tenant: draft.link.tenant,
        generation: "1",
        policyVersion: "1",
        subject: `user:${draft.userId}`,
        domains: ["organization:master-data"],
        objects: ["organization:profile:current"],
        signature: base64(new Uint8Array(64)),
      }),
    ),
  );
  let interruptSetup = true;
  let loseCompletion = false;
  setRequestHook(async (url, next) => {
    const paths = url.pathname.slice(1).split(",");
    if (paths.includes("zerotrust.objects.batch") && interruptSetup) {
      interruptSetup = false;
      throw new TypeError(
        "Simulated interruption before the initial business documents",
      );
    }
    if (paths.includes("zerotrust.setup.complete") && loseCompletion) {
      loseCompletion = false;
      const response = await next();
      assert.equal(response.status, 200);
      await response.arrayBuffer();
      throw new TypeError(
        "Simulated connection loss after readiness publication",
      );
    }
    return next();
  });
  try {
    await assert.rejects(() => initializeTenant(owner, signal, duckDriver));
    assert.equal(interruptSetup, false);
    const interrupted = await required(
      peer.query("zerotrust.status", undefined, { strategy: "network-only" }),
    );
    assert.equal(
      interrupted.initialization,
      null,
      "partially created areas never unlock the application",
    );
    loseCompletion = true;
    await initializeTenant(peer, signal, duckDriver);
    assert.equal(loseCompletion, false);
    await initializeTenant(owner, signal, duckDriver);
    const ready = await required(
      peer.query("zerotrust.status", undefined, { strategy: "network-only" }),
    );
    assert.equal(await verifyTenantInitialized(peer, ready), true);
    assert.ok(ready.initialization);
    await required(
      owner.mutate("zerotrust.setup.complete", ready.initialization),
    );
    const changed = structuredClone(ready);
    changed.initialization!.subject = "user:someone-else";
    await assert.rejects(() => verifyTenantInitialized(peer, changed));
    const access = createContentAccess(owner, () => signal);
    try {
      const permissions = await access.read();
      assert.ok(permissions);
      for (const kind of [
        "products",
        "customers",
        "contacts",
        "vendors",
        "project",
        "commercial",
      ] as const) {
        assert.equal(
          permissions.canCreate(kind),
          true,
          `the first administrator can create ${kind}`,
        );
      }
    } finally {
      access.close();
    }
    const profile = await required(
      owner.query("users.get", { id: draft.userId }),
    );
    assert.equal(profile.username, draft.username);
    assert.deepEqual(await required(owner.query("customers.list", {})), []);
    assert.deepEqual(await required(owner.query("products.list", {})), []);
    assert.equal(
      (await required(owner.query("settings.invoiceNumbering.get", undefined)))
        .startNumber,
      "1",
    );
    console.log(
      "Native tenant setup verified: interrupted initialization, signed readiness, lost response, resume, complete administrator rights and initial business views.",
    );
  } finally {
    setRequestHook(null);
  }
}
