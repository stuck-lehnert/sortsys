import { expect, test } from "bun:test";
import { createIdentity, publicIdentity } from "@sortsys/zerotrust";
import { officeCapsule, officeKey, openOfficeSession, sameOfficeContext, sealOfficeSession } from "./officeCapsule";

const context = { authorityGeneration: "1", policyVersion: "7", keyGeneration: "2" };
const session = { editKey: "/2/integration/edit/abcdefghijklmnopqrstuvwx/", viewKey: "/2/integration/view/ZYXWVUTSRQPONMLKJIHGFEDC/" };
test("shared Office edit capabilities are individually sealed and bind file, epoch, rights and view capability", async () => {
  const writer = await createIdentity(), second = await createIdentity(), reader = await createIdentity();
  const recipients = await Promise.all([["user:1", writer], ["user:2", second]].map(async ([subject, identity]) => ({ subject, encryptionKey: (await publicIdentity(identity)).encryptionKey })));
  const capsule = await sealOfficeSession("tenant", "4", "5", context, session, recipients);
  expect(JSON.stringify(capsule)).not.toContain(session.editKey);
  expect(capsule.viewKey).toBe(session.viewKey);
  expect(await openOfficeSession("tenant", "4", "5", capsule, "user:1", writer)).toEqual(session);
  expect(await openOfficeSession("tenant", "4", "5", capsule, "user:2", second)).toEqual(session);
  await expect(openOfficeSession("tenant", "4", "5", capsule, "user:3", reader)).rejects.toThrow();
  await expect(openOfficeSession("tenant", "4", "5", capsule, "user:1", reader)).rejects.toThrow();
  await expect(openOfficeSession("other", "4", "5", capsule, "user:1", writer)).rejects.toThrow();
  await expect(openOfficeSession("tenant", "6", "5", capsule, "user:1", writer)).rejects.toThrow();
  await expect(openOfficeSession("tenant", "4", "6", capsule, "user:1", writer)).rejects.toThrow();
  for (const changed of [
    { ...capsule, authorityGeneration: "2" }, { ...capsule, policyVersion: "8" }, { ...capsule, keyGeneration: "3" },
    { ...capsule, epoch: "a".repeat(32) }, { ...capsule, viewKey: "/2/integration/view/anotherREADINGcapability/" },
  ]) await expect(openOfficeSession("tenant", "4", "5", changed, "user:1", writer)).rejects.toThrow();
  expect(sameOfficeContext(capsule, context)).toBe(true);
  expect(sameOfficeContext(capsule, { ...context, policyVersion: "8" })).toBe(false);
});
test("Office capsules reject edit-as-view, duplicate recipients, oversized ciphertext and unknown fields", async () => {
  expect(() => officeKey(session.editKey, "view")).toThrow();
  expect(() => officeKey(session.viewKey, "edit")).toThrow();
  expect(() => officeKey(session.viewKey + "?remote=example", "view")).toThrow();
  const writer = await createIdentity(), capsule = await sealOfficeSession("tenant", "4", "5", context, session,
    [{ subject: "user:1", encryptionKey: (await publicIdentity(writer)).encryptionKey }]);
  for (const changed of [
    { ...capsule, writers: [] }, { ...capsule, writers: [...capsule.writers, ...capsule.writers] },
    { ...capsule, editKey: session.editKey }, { ...capsule, epoch: "../../other" }, { ...capsule, policyVersion: "0" },
    { ...capsule, viewKey: session.editKey }, { ...capsule, writers: [{ ...capsule.writers[0], ciphertext: "a".repeat(1000) }] },
  ]) expect(() => officeCapsule(changed)).toThrow();
});
