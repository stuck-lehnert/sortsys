import { expect, test } from "bun:test";
import { assemblePayload, payloadPartHash } from "@sortsys/zerotrust/sortsys";
import vector from "../../../../sortsys-api-v2/rust-api/tests/fixtures/zerotrust-recovery.json";
import { commitRecovery, RecoveryNotStarted } from "./recovery";

const { plan } = vector;
const sourceHead = {
  generation: plan.transition.generation,
  authority: plan.sourceAuthority,
  operation: null,
};
const nextHead = {
  generation: plan.nextSetup.authority.generation,
  authority: plan.nextSetup.authority,
  operation: null,
};

function mock(options = {}) {
  const calls = [];
  const staged = new Map();
  let queryCount = 0;
  let lostStage = false;
  return {
    calls,
    staged,
    async mutate(path, input) {
      calls.push([path, input]);
      if (path === "zerotrust.recovery.stage") {
        const hash = payloadPartHash(input.content);
        staged.set(hash, input.content);
        if (options.loseStage && !lostStage) {
          lostStage = true;
          return [null, new Error("Stage response lost")];
        }
        return [{ hash: options.falseReceipt ? "0".repeat(64) : hash }, null];
      }
      expect(path).toBe("zerotrust.recovery.commit");
      const content = assemblePayload(
        input.manifest,
        input.manifest.parts.map((hash) => staged.get(hash)),
      );
      expect(JSON.parse(content)).toEqual(plan);
      expect(input.authorization.proof).toBe(plan.proof);
      if (options.loseCommit) return [null, new Error("Commit response lost")];
      return [{ success: true }, null];
    },
    async query(path, input) {
      calls.push([path, input]);
      queryCount++;
      if (queryCount === 1) return [options.initialHead ?? sourceHead, null];
      if (Object.hasOwn(options, "head")) return [options.head, null];
      return [nextHead, null];
    },
  };
}

test("recovery publishes only assembled parts and verifies the activated root even after a positive acknowledgement", async () => {
  const client = mock();
  await commitRecovery(client, plan);
  expect(client.calls.map(([path]) => path)).toEqual([
    "zerotrust.recovery.head",
    "zerotrust.recovery.stage",
    "zerotrust.recovery.commit",
    "zerotrust.recovery.head",
  ]);
  const falseSuccess = mock({ head: sourceHead });
  await expect(commitRecovery(falseSuccess, plan)).rejects.toBeInstanceOf(
    RecoveryNotStarted,
  );
});

test("a lost part reply retries the identical chunk and a lost commit is resolved by the signed new root", async () => {
  const client = mock({ loseStage: true, loseCommit: true });
  await commitRecovery(client, plan);
  const uploads = client.calls.filter(
    ([path]) => path === "zerotrust.recovery.stage",
  );
  expect(uploads).toHaveLength(2);
  expect(uploads[0][1]).toEqual(uploads[1][1]);
  expect(client.staged.size).toBe(1);
});

test("an already completed recovery is checked without uploading or publishing again", async () => {
  const client = mock({ initialHead: nextHead });
  await commitRecovery(client, plan);
  expect(client.calls.map(([path]) => path)).toEqual([
    "zerotrust.recovery.head",
  ]);
});

test("a false part receipt never reaches publication and an unknown commit outcome retains the original error", async () => {
  const falseReceipt = mock({ falseReceipt: true, head: sourceHead });
  await expect(commitRecovery(falseReceipt, plan)).rejects.toBeInstanceOf(
    RecoveryNotStarted,
  );
  expect(
    falseReceipt.calls.some(([path]) => path === "zerotrust.recovery.commit"),
  ).toBe(false);
  const disconnected = mock({ loseCommit: true, head: null });
  await expect(commitRecovery(disconnected, plan)).rejects.toThrow(
    "Commit response lost",
  );
});

test("a substituted new authority or generation cannot confirm recovery or authorize an upload", async () => {
  const forged = structuredClone(nextHead);
  const key = forged.authority.authoritySigningKey;
  forged.authority.authoritySigningKey =
    (key[0] === "A" ? "B" : "A") + key.slice(1);
  await expect(commitRecovery(mock({ head: forged }), plan)).rejects.toThrow();
  const unknown = mock({ initialHead: { ...sourceHead, generation: "999" } });
  await expect(commitRecovery(unknown, plan)).rejects.toThrow();
  expect(unknown.calls).toHaveLength(1);
});
