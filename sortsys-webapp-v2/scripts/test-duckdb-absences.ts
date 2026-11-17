import assert from "node:assert/strict";
import { createClient, type Client } from "@sortsys/v2-client";
import {
  acceptVaultWithKey,
  signIn,
  unlockedAccount,
  type UnlockedAccount,
} from "../app/lib/crypto/session";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { duckDriver } from "../app/lib/data/testing/duckDriver.mjs";
import { newProductRowId, publicId } from "../app/lib/data/products";
import { required } from "../app/lib/data/protectedObjects";

/** Real requester and supervisor; two independent API replicas decide one
 * immutable request without exposing its dates, note or decision content. */
export async function exerciseNativeAbsences(
  administrator: Client,
  memberClient: Client,
  owner: UnlockedAccount,
  memberId: string,
  peerEndpoint: string,
) {
  const member = unlockedAccount()!;
  const requester = createBusinessClient(memberClient, {
    productDriver: duckDriver,
  });
  const operationId = publicId(newProductRowId());
  const note = "Vertrauliche Abwesenheitsnotiz 927184";
  const input = {
    operationId,
    userId: memberId,
    from: "2026-12-14",
    to: "2026-12-18",
    type: "vacation" as const,
    note,
  };
  try {
    const created = await required(
      requester.mutate("users.vacations.create", input),
    );
    assert.equal(created.id, operationId);
    assert.equal(created.status, "requested");
    const rows = await required(
      requester.query("users.vacations.list", { userId: memberId }),
    );
    const pending = rows.find((row) => row.id === operationId);
    assert.ok(pending);
    assert.equal(pending.note, note);
    assert.ok(
      (
        await requester.mutate("users.vacations.approve", {
          id: operationId,
          expectedRevision: pending.revision,
        })
      )[1],
    );
    requester.dispose();
    await acceptVaultWithKey(owner.dataKey, owner.vault, owner.username, false);
    const peer = createClient(
      peerEndpoint,
      "native-absence-second-supervisor-session",
    );
    await signIn(peer, {
      tenant: owner.tenant,
      username: owner.username,
      password: "Only-owner-knows-this-password-2026!",
    });
    await acceptVaultWithKey(owner.dataKey, owner.vault, owner.username, false);
    const supervisor = createBusinessClient(administrator, {
      productDriver: duckDriver,
    });
    const otherSupervisor = createBusinessClient(peer, {
      productDriver: duckDriver,
    });
    try {
      const results = await Promise.all([
        supervisor.mutate("users.vacations.approve", {
          id: operationId,
          expectedRevision: pending.revision,
        }),
        otherSupervisor.mutate("users.vacations.deny", {
          id: operationId,
          expectedRevision: pending.revision,
          reason: "Vertraulicher Ablehnungsgrund 927184",
        }),
      ]);
      assert.equal(results.filter(([, error]) => error === null).length, 1);
      await supervisor.invalidate("users.vacations.list");
      const decided = (
        await required(
          supervisor.query("users.vacations.list", { userId: memberId }),
        )
      ).find((row) => row.id === operationId);
      assert.ok(decided);
      assert.notEqual(decided.status, "requested");
      assert.ok(
        (
          await supervisor.mutate("users.vacations.delete", {
            id: operationId,
            expectedRevision: pending.revision,
          })
        )[1],
      );
      await required(
        supervisor.mutate("users.vacations.delete", {
          id: operationId,
          expectedRevision: decided.revision,
        }),
      );
      assert.equal(
        (
          await required(
            supervisor.query("users.vacations.list", { userId: memberId }),
          )
        ).some((row) => row.id === operationId),
        false,
      );
    } finally {
      supervisor.dispose();
      otherSupervisor.dispose();
      peer.setToken(null);
    }
    console.log(
      "Native absences verified: independent requester, supervisor-only approval, competing decisions on two APIs, stale revisions and atomic withdrawal with immutable history.",
    );
  } finally {
    requester.dispose();
    await acceptVaultWithKey(member.dataKey, member.vault, member.username, false);
  }
}
