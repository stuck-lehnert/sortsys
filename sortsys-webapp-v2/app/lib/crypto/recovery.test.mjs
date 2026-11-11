import { expect, test } from "bun:test";
import vector from "../../../../sortsys-api-v2/rust-api/tests/fixtures/zerotrust-recovery.json";
import { commitRecovery, RecoveryNotStarted } from "./recovery";

const { plan } = vector;
function mock(head) {
  const calls = [];
  return { calls,
    mutate: async (path, input) => { calls.push([path, input]); return path.endsWith("begin") ? [null, new Error("Response lost")] : [{ success: true }, null]; },
    query: async () => [head, null],
  };
}

test("a lost recovery response resumes the same authorized operation without credentials", async () => {
  const client = mock({ generation: plan.nextSetup.authority.generation, authority: plan.nextSetup.authority, operation: plan.transition.operation });
  await commitRecovery(client, plan);
  expect(client.calls.map(([name]) => name)).toEqual(["zerotrust.recovery.begin", "zerotrust.recovery.resume"]);
  expect(client.calls[1][1]).toEqual({ tenant: plan.transition.tenant, operation: plan.transition.operation });
});

test("an already completed recovery remains successful after a lost response", async () => {
  const client = mock({ generation: plan.nextSetup.authority.generation, authority: plan.nextSetup.authority, operation: null });
  await commitRecovery(client, plan);
  expect(client.calls).toHaveLength(1);
});

test("a plan that never started can be rebuilt while an unknown outcome retains the prepared plan", async () => {
  const client = mock({ generation: plan.transition.generation, authority: plan.sourceAuthority, operation: null });
  await expect(commitRecovery(client, plan)).rejects.toBeInstanceOf(RecoveryNotStarted);
  const disconnected = mock(null);
  await expect(commitRecovery(disconnected, plan)).rejects.toThrow("Response lost");
});
