import { afterEach, expect, test } from "bun:test";
import {
  base64,
  bytes,
  digest,
  encryptObject,
  evaluateOtsProof,
  importSigningKey,
  objectTimestampTarget,
  OTS_CALENDARS,
  serializeOtsProof,
  sized,
} from "@sortsys/zerotrust/sortsys";
import {
  checkTimestampEvidence,
  startTimestampEvidence,
  timestampEvidenceAttempt,
} from "./timestampEvidence";
import { lockCryptoSession, unlockedAccount } from "./session";
import { protectedTenant } from "../data/testing/protectedTenant.mjs";
import { announceDataChanges } from "../data/runtime/changes";
afterEach(() => lockCryptoSession());
const pending = (root, calendar = OTS_CALENDARS[0]) => {
  const uri = bytes(calendar);
  return serializeOtsProof({
    hash: 8,
    digest: root,
    node: {
      attestations: [
        {
          tag: new Uint8Array([131, 223, 227, 13, 46, 249, 12, 142]),
          payload: new Uint8Array([uri.length, ...uri]),
        },
      ],
      edges: [],
    },
  });
};
async function fixture() {
  const area = {
    scope: "absence:2",
    domain: "absence:2:master-data",
    facet: "master-data",
    prefix: "absence:2:request:",
  };
  const decisions = {
    scope: area.scope,
    domain: "absence:2:personnel",
    facet: "personnel",
    prefix: "absence:2:decision:",
  };
  const f = await protectedTenant([area, decisions]),
    identity = unlockedAccount().identity;
  await f.seed(area, area.prefix + "3", { reason: "Geheim 7381" });
  const artifact = f.objects.get(area.prefix + "3"),
    target = await objectTimestampTarget(
      artifact,
      identity.signingKey.publicKey,
    );
  const evidence = { target, artifact, proofs: [] },
    finishes = [];
  const baseMutate = f.client.mutate;
  f.client.mutate = async (path, input) => {
    if (path === "zerotrust.timestamps.work")
      return [{ lease: "lease_1", evidence: structuredClone(evidence) }, null];
    if (path === "zerotrust.timestamps.finish") {
      finishes.push(structuredClone(input));
      if (input.proof && !evidence.proofs.includes(input.proof))
        evidence.proofs.push(input.proof);
      return [null, null];
    }
    return baseMutate(path, input);
  };
  return { ...f, evidence, finishes };
}
test("real signed ciphertext binds the exact external root and export packet", async () => {
  const f = await fixture(),
    result = await checkTimestampEvidence(
      f.client,
      f.evidence,
      f.evidence.target,
      new AbortController().signal,
    );
  expect(await digest(result.packet)).toBe(result.target.digest);
  expect(result.proof).toBeNull();
  expect(JSON.stringify(f.calls)).not.toContain("Geheim 7381");
});
test("valid evidence for another request or revision is rejected before any key or calendar lookup", async () => {
  const f = await fixture(),
    signal = new AbortController().signal,
    target = f.evidence.target;
  const calls = f.calls.length;
  for (const mismatch of [
    { scope: "absence:3" },
    { object: "absence:2:request:4" },
    { revision: "2" },
  ]) {
    await expect(
      checkTimestampEvidence(
        f.client,
        f.evidence,
        { ...target, ...mismatch },
        signal,
      ),
    ).rejects.toThrow();
  }
  expect(f.calls.length).toBe(calls);
  expect(f.finishes).toHaveLength(0);
});
test("optional proof absence does not block stamping; a partial outage can yield durable evidence", async () => {
  const f = await fixture(),
    signal = new AbortController().signal;
  expect(
    await timestampEvidenceAttempt(f.client, signal, {
      stamp: async (root) => pending(root),
    }),
  ).toBe("submitted");
  expect(f.finishes.length).toBe(1);
  expect(f.finishes[0].proof).toBeString();
  const checked = await checkTimestampEvidence(
    f.client,
    f.evidence,
    f.evidence.target,
    signal,
  );
  expect(
    (await evaluateOtsProof(checked.proof, sized(checked.target.digest, 32)))[0]
      .kind,
  ).toBe("pending");
});
test("outage sends null as retry-only and retains every earlier proof and immutable signature", async () => {
  const f = await fixture(),
    original = structuredClone(f.evidence);
  f.evidence.proofs.push(base64(pending(sized(f.evidence.target.digest, 32))));
  const proofs = [...f.evidence.proofs];
  expect(
    await timestampEvidenceAttempt(f.client, new AbortController().signal, {
      upgrade: async () => {
        throw new Error("Calendar down");
      },
    }),
  ).toBe("deferred");
  expect(f.finishes[0].proof).toBeNull();
  expect(f.evidence.proofs).toEqual(proofs);
  expect(f.evidence.target).toEqual(original.target);
  expect(f.evidence.artifact).toEqual(original.artifact);
});
test("forged target, ciphertext and unrelated proof never get submitted to a calendar", async () => {
  for (const change of [
    (e) => (e.target.digest = base64(new Uint8Array(32))),
    (e) => (e.artifact.policyVersion = "2"),
    (e) => e.proofs.push(base64(pending(new Uint8Array(32)))),
    (e) => (e.target.ots = null),
  ]) {
    const f = await fixture();
    change(f.evidence);
    let sent = false;
    await timestampEvidenceAttempt(f.client, new AbortController().signal, {
      stamp: async () => {
        sent = true;
        throw new Error();
      },
      upgrade: async () => {
        sent = true;
        throw new Error();
      },
    });
    expect(sent).toBe(false);
    expect(f.finishes[0].proof).toBeNull();
  }
});
test("an unchanged pending calendar proof preserves evidence and defers further work", async () => {
  const f = await fixture();
  const proof = base64(pending(sized(f.evidence.target.digest, 32)));
  f.evidence.proofs.push(proof);
  expect(
    await timestampEvidenceAttempt(f.client, new AbortController().signal, {
      upgrade: async (bytes) => bytes,
    }),
  ).toBe("deferred");
  expect(f.evidence.proofs).toEqual([proof]);
  expect(f.finishes[0].proof).toBeString();
});

test("an empty timestamp queue can wake for a newly published document", async () => {
  const f = await fixture();
  const controller = new AbortController();
  let attempts = 0;
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const stop = startTimestampEvidence(f.client, controller.signal, {
    intervalMs: 60_000,
    attempt: async () => {
      attempts++;
      started();
      return "empty";
    },
  });
  try {
    await ready;
    announceDataChanges(f.client, new Set(["commercial:2:scope"]));
    await Bun.sleep(1100);
    expect(attempts).toBe(2);
  } finally {
    controller.abort();
    stop();
  }
});
test("even an injected calendar adapter cannot replace the signed packet root", async () => {
  const f = await fixture();
  await timestampEvidenceAttempt(f.client, new AbortController().signal, {
    stamp: async () => pending(new Uint8Array(32)),
  });
  expect(f.finishes[0].proof).toBeNull();
});
test("multiple stored receipts are merged without losing earlier calendars", async () => {
  const f = await fixture(),
    root = sized(f.evidence.target.digest, 32);
  f.evidence.proofs.push(
    base64(pending(root)),
    base64(pending(root, OTS_CALENDARS[1])),
  );
  const result = await checkTimestampEvidence(
    f.client,
    f.evidence,
    f.evidence.target,
    new AbortController().signal,
  );
  expect(
    (await evaluateOtsProof(result.proof, root))
      .map((claim) => claim.calendar)
      .sort(),
  ).toEqual(OTS_CALENDARS.slice(0, 2).sort());
});
test("abort or account lock while a calendar replies never publishes into another account", async () => {
  for (const lock of [false, true]) {
    const f = await fixture(),
      controller = new AbortController();
    await expect(
      timestampEvidenceAttempt(f.client, controller.signal, {
        stamp: async (root) => {
          if (lock) await lockCryptoSession();
          else controller.abort();
          return pending(root);
        },
      }),
    ).rejects.toThrow();
    expect(f.finishes).toHaveLength(0);
  }
});
test("denied work and missing work produce no calendar traffic", async () => {
  const f = await fixture();
  let submitted = 0;
  const stamp = async () => {
    submitted++;
    throw new Error();
  };
  f.client.mutate = async () => [null, null];
  expect(
    await timestampEvidenceAttempt(f.client, new AbortController().signal, {
      stamp,
    }),
  ).toBe("empty");
  f.client.mutate = async () => [null, new Error("forbidden")];
  await expect(
    timestampEvidenceAttempt(f.client, new AbortController().signal, { stamp }),
  ).rejects.toThrow();
  expect(submitted).toBe(0);
});
test("the background runner serializes attempts and stops when its account closes", async () => {
  const f = await fixture(),
    controller = new AbortController();
  let calls = 0,
    running = 0,
    peak = 0;
  const stop = startTimestampEvidence(f.client, controller.signal, {
    intervalMs: 20,
    attempt: async () => {
      calls++;
      running++;
      peak = Math.max(peak, running);
      await Bun.sleep(5);
      running--;
      return "empty";
    },
  });
  await Bun.sleep(15);
  expect(calls).toBe(1);
  announceDataChanges(f.client, new Set(["catalog:products:master-data"]));
  await Bun.sleep(35);
  expect(peak).toBe(1);
  controller.abort();
  stop();
  const previous = calls;
  await Bun.sleep(50);
  expect(calls).toBe(previous);
});

test("a calendar outage pauses queued records after one safely released attempt", async () => {
  const f = await fixture();
  const controller = new AbortController();
  let calendarCalls = 0;
  let complete;
  const finished = new Promise((resolve) => {
    complete = resolve;
  });
  const stop = startTimestampEvidence(f.client, controller.signal, {
    intervalMs: 60_000,
    attempt: async (client, signal) => {
      const progressed = await timestampEvidenceAttempt(client, signal, {
        stamp: async () => {
          calendarCalls++;
          throw new Error("Calendar unavailable");
        },
      });
      complete();
      return progressed;
    },
  });
  try {
    await finished;
    await Bun.sleep(30);
    expect(calendarCalls).toBe(1);
    expect(f.finishes).toHaveLength(1);
    expect(f.finishes[0].proof).toBeNull();
    expect(f.evidence.proofs).toEqual([]);
    for (let index = 0; index < 10; index++) {
      announceDataChanges(f.client, new Set(["commercial:2:scope"]));
    }
    await Bun.sleep(1100);
    expect(calendarCalls).toBe(1);
    expect(f.finishes).toHaveLength(1);
  } finally {
    controller.abort();
    stop();
  }
});
