import { expect, test } from "bun:test";
import { createClient } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import superjson from "superjson";
import {
  checkExpectedRevision,
  commitProtectedWrites,
  mergePreparedWrites,
  ProtectedWriteConflict,
} from "./atomicWrites";
import { ramCache } from "./ramCache";

test("optional object revisions distinguish missing, malformed and stale expectations", () => {
  expect(() => checkExpectedRevision(undefined, "10")).not.toThrow();
  expect(() => checkExpectedRevision("0", undefined)).not.toThrow();
  expect(() => checkExpectedRevision("10", "10")).not.toThrow();

  const largestRevision = "9223372036854775807";
  expect(() =>
    checkExpectedRevision(largestRevision, largestRevision),
  ).not.toThrow();

  for (const input of [null, 10, "010", "-1", "10000000000000000000"]) {
    expect(() => checkExpectedRevision(input, "10")).toThrow(
      InvalidProtectedData,
    );
  }

  expect(() => checkExpectedRevision("9", "10")).toThrow(
    ProtectedWriteConflict,
  );
  expect(() => checkExpectedRevision("1", undefined)).toThrow(
    ProtectedWriteConflict,
  );
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("disjoint changes to one domain retain both verifications and reject overlapping writes or heads", async () => {
  const first = group(1);
  const second = group(1);
  second.packets[0].envelope.object = "item:other";
  const checked = [];
  first.verify = async () => {
    checked.push("first");
    return true;
  };
  second.verify = async () => {
    checked.push("second");
    return false;
  };
  const merged = mergePreparedWrites([first, second]);
  expect(merged).toHaveLength(1);
  expect(merged[0].packets).toHaveLength(2);
  expect(await merged[0].verify()).toBe(false);
  expect(checked).toEqual(["first", "second"]);
  expect(() => mergePreparedWrites([first, first])).toThrow();
  second.head.sequence = "2";
  expect(() => mergePreparedWrites([first, second])).toThrow(
    ProtectedWriteConflict,
  );
});

function group(count) {
  return {
    packets: Array.from({ length: count }, (_, id) => ({
      domain: "area",
      messageId: `msg-${id}`,
      envelope: { object: `item:${id}`, ciphertext: "ciphertext" },
    })),
    head: { domain: "area", sequence: "1" },
    async verify() {
      return true;
    },
    close() {},
  };
}

test("independent publication confirmations overlap, remain bounded and finish before a failed write returns", async () => {
  let active = 0;
  let maximum = 0;
  let rejected = false;
  const groups = Array.from({ length: 6 }, (_, index) => {
    const item = group(1);
    item.head.domain = `area:${index}`;
    item.packets[0].domain = item.head.domain;
    item.packets[0].envelope.object = `item:${index}`;
    item.verify = async () => {
      active++;
      maximum = Math.max(maximum, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return !(rejected && index === 0);
      } finally {
        active--;
      }
    };
    return item;
  });
  const lostReply = new Error("Connection lost after publication");
  const client = {
    async mutate() {
      return [null, lostReply];
    },
    async invalidate() {},
  };
  await commitProtectedWrites(client, groups, new AbortController().signal);
  expect(maximum).toBeGreaterThan(1);
  expect(maximum).toBeLessThanOrEqual(4);
  rejected = true;
  await expect(
    commitProtectedWrites(client, groups, new AbortController().signal),
  ).rejects.toBe(lostReply);
  expect(active).toBe(0);
});

test("a policy-only publication cannot accept a false successful reply without its durable signed receipt", async () => {
  const calls = [];
  const guards = Array.from({ length: 129 }, (_, index) => ({
    domain: `personnel:${(index + 2).toString(32)}:scope`,
    sequence: "7",
  }));
  let accepted = false;
  const client = {
    async mutate(path, input) {
      calls.push({ path, input });
      return [{ success: true }, null];
    },
    async invalidate() {},
  };
  const policy = {
    async bind(packets, heads) {
      expect(packets).toEqual([]);
      expect(heads).toEqual(guards);
      return { signature: "public-test-policy" };
    },
    async verify() {
      return accepted;
    },
  };
  await expect(
    commitProtectedWrites(client, [], new AbortController().signal, guards, {
      policy,
    }),
  ).rejects.toBeInstanceOf(ProtectedWriteConflict);
  accepted = true;
  await commitProtectedWrites(
    client,
    [],
    new AbortController().signal,
    guards,
    { policy },
  );
  expect(calls.map((call) => call.path)).toEqual([
    "zerotrust.objects.batch",
    "zerotrust.objects.batch",
  ]);
  expect(calls[0].input.objects).toEqual([]);
});

test("independent preparations share equal read prerequisites without dropping conflicting snapshots", async () => {
  const first = group(1);
  const second = group(1);
  const sent = [];
  second.head = { domain: "decision", sequence: "0" };
  second.packets = second.packets.map((packet) => ({
    ...packet,
    domain: "decision",
  }));
  const client = {
    async mutate(path, input) {
      sent.push(input);
      return [{ success: true }, null];
    },
    async invalidate() {},
  };
  const guards = [
    first.head,
    second.head,
    { domain: "profile", sequence: "7" },
    { domain: "profile", sequence: "7" },
  ];
  await commitProtectedWrites(
    client,
    [first, second],
    new AbortController().signal,
    guards,
  );
  expect(sent).toHaveLength(1);
  expect(sent[0].heads).toEqual([
    first.head,
    second.head,
    { domain: "profile", sequence: "7" },
  ]);
  await expect(
    commitProtectedWrites(
      client,
      [first, second],
      new AbortController().signal,
      [...guards, { domain: "area", sequence: "2" }],
    ),
  ).rejects.toBeInstanceOf(ProtectedWriteConflict);
  expect(sent).toHaveLength(1);
  await expect(
    commitProtectedWrites(client, [first, first], new AbortController().signal),
  ).rejects.toThrow();
  expect(sent).toHaveLength(1);
});

test("large encrypted batches upload bounded parts and publish only once", async () => {
  const calls = [];
  const source = group(150);
  const client = {
    async mutate(path, input) {
      calls.push({ path, input });
      return [
        path.endsWith(".stage")
          ? { id: String(calls.length).padStart(64, "0") }
          : { success: true },
        null,
      ];
    },
    async invalidate() {},
  };
  await commitProtectedWrites(client, [source], new AbortController().signal);
  expect(calls.map((call) => call.path)).toEqual([
    "zerotrust.objects.stage",
    "zerotrust.objects.stage",
    "zerotrust.objects.stage",
    "zerotrust.objects.commit",
  ]);
  expect(calls.slice(0, 3).map((call) => call.input.objects.length)).toEqual([
    64, 64, 22,
  ]);
  expect(calls[3].input.heads).toEqual([source.head]);
  expect(calls[3].input.parts).toHaveLength(3);
});

test("staged writes share real HTTP transport batches before the separate final commit", async () => {
  const transmissions = [];
  const source = group(150);
  let verified = false;
  source.verify = async () => {
    verified = true;
    return true;
  };
  // Exercise the production RPC serializer and batch window. This transport
  // fixture acknowledges opaque packets; native tests cover the API checks.
  const client = createClient("https://staged-writes.test", "staging-test", {
    cache: ramCache(),
    fetch: async (input, options) => {
      const paths = new URL(String(input)).pathname.slice(1).split(",");
      const encoded = JSON.parse(String(options.body));
      const inputs = paths.map((_, index) =>
        superjson.deserialize(encoded[index]),
      );
      transmissions.push({ paths, inputs });
      return new Response(
        JSON.stringify(
          paths.map((path, index) => ({
            result: {
              data: superjson.serialize(
                path === "zerotrust.objects.stage"
                  ? { id: String(index + 1).padStart(64, "0") }
                  : { success: true },
              ),
            },
          })),
        ),
      );
    },
  });
  client.setToken("disposable-staging-session");
  await commitProtectedWrites(client, [source], new AbortController().signal);
  expect(transmissions.map((request) => request.paths)).toEqual([
    Array(3).fill("zerotrust.objects.stage"),
    ["zerotrust.objects.commit"],
  ]);
  expect(transmissions[0].inputs.map((input) => input.objects.length)).toEqual([
    64, 64, 22,
  ]);
  expect(transmissions[1].inputs[0].parts).toEqual([
    "1".padStart(64, "0"),
    "2".padStart(64, "0"),
    "3".padStart(64, "0"),
  ]);
  expect(transmissions[1].inputs[0].heads).toEqual([source.head]);
  expect(verified).toBe(true);
});

test("concurrent stage acknowledgements retain part order and stay within four in-flight uploads", async () => {
  const source = group(64 * 9);
  const gates = Array.from({ length: 9 }, deferred);
  const started = Array.from({ length: 9 }, deferred);
  const releases = [3, 2, 1, 0, 7, 6, 5, 4, 8];
  const calls = [];
  let active = 0;
  let maximum = 0;
  let committed = false;
  const client = {
    async mutate(path, input) {
      if (path === "zerotrust.objects.commit") {
        expect(active).toBe(0);
        expect(input.parts).toEqual(
          gates.map((_, index) => String(index + 1).padStart(64, "0")),
        );
        committed = true;
        return [{ success: true }, null];
      }
      const index = calls.length;
      calls.push(input.objects);
      active++;
      maximum = Math.max(maximum, active);
      started[index].resolve();
      try {
        await gates[index].promise;
        return [{ id: String(index + 1).padStart(64, "0") }, null];
      } finally {
        active--;
      }
    },
    async invalidate() {},
  };
  const result = commitProtectedWrites(
    client,
    [source],
    new AbortController().signal,
  );
  await started[3].promise;
  expect(calls).toHaveLength(4);
  for (const index of releases) {
    await started[index].promise;
    expect(committed).toBe(false);
    gates[index].resolve();
  }
  await result;
  expect(committed).toBe(true);
  expect(maximum).toBe(4);
  expect(calls.flat()).toEqual(source.packets);
});

for (const failureKind of ["denied", "invalid-receipt", "cancelled"]) {
  test(`${failureKind} staging stops queued uploads, drains started peers and never publishes`, async () => {
    const source = group(64 * 9);
    const gates = Array.from({ length: 4 }, deferred);
    const started = deferred();
    const controller = new AbortController();
    const failure = new Error("Stage denied");
    const calls = [];
    let active = 0;
    let settled = false;
    let verified = false;
    source.verify = async () => {
      verified = true;
      return true;
    };
    const client = {
      async mutate(path) {
        const index = calls.length;
        calls.push(path);
        active++;
        if (active === 4) started.resolve();
        try {
          await gates[index].promise;
          if (index === 0) {
            if (failureKind === "denied") return [null, failure];
            if (failureKind === "invalid-receipt") return [{ id: "bad" }, null];
            controller.abort(failure);
          }
          return [{ id: String(index + 1).padStart(64, "0") }, null];
        } finally {
          active--;
        }
      },
      async invalidate() {},
    };
    const result = commitProtectedWrites(client, [source], controller.signal);
    const outcome = result.then(
      () => {
        settled = true;
        return { success: true };
      },
      (error) => {
        settled = true;
        return { error };
      },
    );
    await started.promise;
    gates[0].resolve();
    // Leave the three started peers pending while the first failure settles.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(active).toBe(3);
    expect(calls).toEqual(Array(4).fill("zerotrust.objects.stage"));
    for (const gate of gates.slice(1)) gate.resolve();
    const finished = await outcome;
    expect(finished.error).toBeInstanceOf(Error);
    expect(active).toBe(0);
    expect(verified).toBe(false);
    expect(calls).toEqual(Array(4).fill("zerotrust.objects.stage"));
  });
}

test("a small write with many read prerequisites uses one prepared publication and retains every guard", async () => {
  const source = group(1);
  const guards = Array.from({ length: 128 }, (_, index) => ({
    domain: `prerequisite:${index}`,
    sequence: "7",
  }));
  const calls = [];
  const client = {
    async mutate(path, input) {
      calls.push({ path, input });
      return [
        path.endsWith(".stage") ? { id: "a".repeat(64) } : { success: true },
        null,
      ];
    },
    async invalidate() {},
  };
  await commitProtectedWrites(
    client,
    [source],
    new AbortController().signal,
    guards,
  );
  expect(calls.map((call) => call.path)).toEqual([
    "zerotrust.objects.stage",
    "zerotrust.objects.commit",
  ]);
  expect(calls[1].input.heads).toEqual([source.head, ...guards]);
  expect(calls[1].input.parts).toEqual(["a".repeat(64)]);
});

test("a failed or cancelled stage never attempts publication", async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    const paths = [];
    const failed = new Error("Stage unavailable");
    const client = {
      async mutate(path) {
        paths.push(path);
        if (cancel) controller.abort();
        return [null, failed];
      },
      async invalidate() {},
    };
    await expect(
      commitProtectedWrites(client, [group(70)], controller.signal),
    ).rejects.toThrow();
    expect(paths).toEqual(
      Array(cancel ? 1 : 2).fill("zerotrust.objects.stage"),
    );
  }
});

test("a successful commit response still requires checked readback", async () => {
  const source = group(70);
  source.verify = async () => false;
  const client = {
    async mutate(path) {
      return [
        path.endsWith(".stage") ? { id: "a".repeat(64) } : { success: true },
        null,
      ];
    },
    async invalidate() {},
  };
  await expect(
    commitProtectedWrites(client, [source], new AbortController().signal),
  ).rejects.toBeInstanceOf(ProtectedWriteConflict);
});

test("a rejected publication retains its original conflict when readback has no newly created object", async () => {
  const conflict = Object.assign(new Error("Concurrent write"), {
    code: "CONFLICT",
  });
  const missing = new Error("Object was never created");
  const source = group(1);
  source.verify = async () => {
    throw missing;
  };
  const client = {
    async mutate() {
      return [null, conflict];
    },
    async invalidate() {},
  };
  await expect(
    commitProtectedWrites(client, [source], new AbortController().signal),
  ).rejects.toBe(conflict);
  client.mutate = async () => [{ success: true }, null];
  await expect(
    commitProtectedWrites(client, [source], new AbortController().signal),
  ).rejects.toBe(missing);
});

test("account effects and ciphertext require both readbacks, including a thrown lost reply", async () => {
  const source = group(1);
  const sent = [];
  const failure = new Error("Lost combined response");
  let effect = false;
  const client = {
    async mutate(path, input) {
      sent.push({ path, input });
      throw failure;
    },
    async invalidate() {},
  };
  const member = {
    change: { requestId: "test-change" },
    async verify() {
      return effect;
    },
  };
  await expect(
    commitProtectedWrites(client, [source], new AbortController().signal, [], {
      member,
    }),
  ).rejects.toBe(failure);
  effect = true;
  await commitProtectedWrites(
    client,
    [source],
    new AbortController().signal,
    [],
    { member },
  );
  expect(sent[1].input.member).toEqual(member.change);
  expect(sent.every((call) => call.path === "zerotrust.objects.batch")).toBe(
    true,
  );
});

test("a rename, multiple private facets and supervisor permissions share one verified commit", async () => {
  const source = group(2);
  const calls = [];
  const checked = [];
  const member = {
    change: { requestId: "rename:1", action: "rename", username: "new.alias" },
    async verify() {
      checked.push("member");
      return true;
    },
  };
  const policy = {
    async bind(packets, heads) {
      expect(packets).toHaveLength(2);
      expect(heads).toEqual([source.head]);
      return { signature: "signed-supervisor-policy" };
    },
    async verify() {
      checked.push("policy");
      return true;
    },
  };
  const client = {
    async mutate(path, input) {
      calls.push({ path, input });
      throw new Error("Lost combined reply");
    },
    async invalidate() {},
  };
  source.verify = async () => {
    checked.push("private");
    return true;
  };
  await commitProtectedWrites(
    client,
    [source],
    new AbortController().signal,
    [],
    { member, policy },
  );
  expect(calls).toHaveLength(1);
  expect(calls[0].path).toBe("zerotrust.objects.batch");
  expect(calls[0].input.member).toEqual(member.change);
  expect(calls[0].input.policy.signature).toBe("signed-supervisor-policy");
  expect(checked.sort()).toEqual(["member", "policy", "private"]);
  member.change.action = "deactivate";
  await expect(
    commitProtectedWrites(client, [source], new AbortController().signal, [], {
      member,
      policy,
    }),
  ).rejects.toThrow();
  expect(calls).toHaveLength(1);
});
