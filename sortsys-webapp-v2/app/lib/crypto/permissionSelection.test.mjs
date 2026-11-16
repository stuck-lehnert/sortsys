import { afterEach, expect, test } from "bun:test";
import {
  permissionSelection,
  rememberPermissionSelection,
} from "./permissionSelection";
import { lockCryptoSession } from "./session";
import { protectedTenant } from "../data/testing/protectedTenant.mjs";

afterEach(() => lockCryptoSession());

test("view replacement retains only selected identifiers and returned snapshots cannot modify them", async () => {
  await protectedTenant([]);
  rememberPermissionSelection({
    member: "2",
    area: "catalog:products:master-data",
  });
  const selected = permissionSelection();
  expect(selected).toEqual({
    member: "2",
    area: "catalog:products:master-data",
  });
  selected.member = "3";
  expect(permissionSelection().member).toBe("2");
  rememberPermissionSelection({ member: "4" });
  expect(permissionSelection()).toEqual({
    member: "4",
    area: "catalog:products:master-data",
  });
});

test("locking and replacing the account never carries the previous account's recipient or area into a new view", async () => {
  await protectedTenant([]);
  rememberPermissionSelection({
    member: "2",
    area: "catalog:products:master-data",
  });
  await lockCryptoSession();
  expect(permissionSelection()).toEqual({ member: null, area: null });
  rememberPermissionSelection({ member: "3" });
  await protectedTenant([]);
  expect(permissionSelection()).toEqual({ member: null, area: null });
});
