import assert from "node:assert/strict";
import type { Client } from "@sortsys/v2-client";
import {
  areaKey,
  bytes,
  decryptObject,
  encryptObject,
  openBox,
} from "@sortsys/zerotrust/sortsys";
import {
  acceptVaultWithKey,
  trustedHistory,
  type UnlockedAccount,
} from "../app/lib/crypto/session";
import { changeProjectAccess } from "../app/lib/crypto/permissions";
import { createProjectArea } from "../app/lib/data/createProjectArea";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { ProtectedWriteConflict } from "../app/lib/data/atomicWrites";
import { newProductRowId, publicId } from "../app/lib/data/products";
import type { DuckDriver } from "../app/lib/data/database";
import {
  fileCollection,
  fileObject,
  filePayload,
} from "../app/lib/data/projectFileData";
import {
  protectedCollection,
  required,
} from "../app/lib/data/protectedObjects";
import {
  openOfficeSession,
  sameOfficeContext,
} from "../app/lib/data/officeCapsule";
import {
  officeRecipients,
  sameOfficeRecipients,
} from "../app/lib/data/officeRecipients";

export async function testFilePermissions(
  rootClient: Client,
  memberClient: Client,
  root: UnlockedAccount,
  member: UnlockedAccount,
  driver: () => Promise<DuckDriver>,
  signal: AbortSignal,
  projectId: string,
) {
  const user = `user:${(await required(memberClient.query("auth.sessionInfo", undefined))).user.id}`;
  let owner = createBusinessClient(rootClient, { productDriver: driver }),
    business: ReturnType<typeof createBusinessClient> | undefined;
  const id = await owner.files.upload({
    projectId,
    name: "Geschützter Ausführungsplan.txt",
    mime: "text/plain",
    blob: new Blob(["First private file revision"]),
  });
  const room = (letter: string) => ({
    editKey: `/2/integration/edit/${letter.repeat(24)}/`,
    viewKey: `/2/integration/view/${letter.repeat(32)}/`,
  });
  try {
    await acceptVaultWithKey(member.dataKey, member.vault, member.username, false);
    business = createBusinessClient(memberClient, { productDriver: driver });
    assert.ok(
      (await business.query("projects.files.list", { projectId }))[1],
      "Master-data access does not grant the file key",
    );
    await assert.rejects(() => business!.files.blob(projectId, id));
    assert.ok(
      (
        await memberClient.queryDynamic(
          "zerotrust.migration.file",
          { fileId: id, thumbnail: false },
          { strategy: "network-only" },
        )
      )[1],
      "Legacy source access cannot bypass a missing file grant",
    );
    business.dispose();
    await acceptVaultWithKey(root.dataKey, root.vault, root.username, false);
    await changeProjectAccess(
      rootClient,
      user,
      projectId,
      "read",
      signal,
      "attachment",
    );
    const readerRoom = await owner.files.publishOfficeSession(
      projectId,
      id,
      undefined,
      room("a"),
    );
    await acceptVaultWithKey(member.dataKey, member.vault, member.username, false);
    business = createBusinessClient(memberClient, { productDriver: driver });
    assert.equal(
      await (await business.files.blob(projectId, id)).text(),
      "First private file revision",
    );
    const readerOffice = await business.files.officeStatus(projectId, id);
    assert.equal(readerOffice.canEdit, false);
    await assert.rejects(() =>
      business!.files.publishOfficeSession(projectId, id, undefined, room("b")),
    );
    await assert.rejects(() =>
      business!.files.saveOffice(
        projectId,
        id,
        readerRoom.epoch,
        BigInt(readerOffice.contentVersion),
        new Blob(["Denied Office save"]),
      ),
    );
    const readerMetadata = await protectedCollection(
      memberClient,
      fileCollection(projectId),
      signal,
    );
    try {
      const entry = (await readerMetadata.read()).find(
        (entry) => entry.envelope.object === fileObject(projectId, id),
      )!;
      const capsule = filePayload(
        entry.value,
        entry.envelope.object,
        projectId,
      ).office!;
      assert.ok(
        capsule,
        "A reader must see the confirmed encrypted room metadata",
      );
      const authorization = readerMetadata.authorization();
      assert.equal(
        sameOfficeContext(capsule, authorization),
        true,
        `Room versions differ: ${JSON.stringify({
          stored: [
            capsule.authorityGeneration,
            capsule.policyVersion,
            capsule.keyGeneration,
          ],
          current: [
            authorization.authorityGeneration,
            authorization.policyVersion,
            authorization.keyGeneration,
          ],
        })}`,
      );
      assert.equal(
        sameOfficeRecipients(
          capsule,
          await officeRecipients(memberClient, authorization, signal),
        ),
        true,
        "Reader and writer must agree on the room's editing recipients",
      );
      assert.equal(readerOffice.accessKey, readerRoom.viewKey);
      assert.equal(readerOffice.accessKey?.includes("/edit/"), false);
      await assert.rejects(
        () =>
          openOfficeSession(
            member.tenant,
            projectId,
            id,
            capsule,
            user,
            member.identity,
          ),
        "Decrypting the whole file metadata must not reveal the editing capability to a reader",
      );
    } finally {
      readerMetadata.close();
    }
    assert.ok(
      (
        await business.mutate("projects.files.rename", {
          projectId,
          fileId: id,
          fileName: "Denied rename",
        })
      )[1],
    );
    await assert.rejects(() =>
      business!.files.upload({
        projectId,
        name: "Denied upload",
        mime: "text/plain",
        blob: new Blob(["Denied"]),
      }),
    );
    const area = fileCollection(projectId),
      history = await trustedHistory(memberClient);
    const current = (
      await required(memberClient.query("zerotrust.domains.list", undefined))
    ).find((domain) => domain.id === area.domain)!;
    const box = await required(
      memberClient.query(
        "zerotrust.keys.get",
        { domain: area.domain, generation: current.generation },
        { strategy: "network-only" },
      ),
    );
    const raw = await openBox(
      box,
      {
        tenant: member.tenant,
        purpose: "area-key",
        object: area.domain,
        generation: current.generation,
        recipient: user,
        author: box.author,
      },
      member.identity.encryptionKey.privateKey,
      history.authority(box.author.split(":")[1]),
    );
    let knownKey: CryptoKey;
    try {
      knownKey = await areaKey(raw);
    } finally {
      raw.fill(0);
    }
    const permissions = await required(
      memberClient.query("zerotrust.policy.get", undefined, {
        strategy: "network-only",
      }),
    );
    const unauthorized = await encryptObject(
      {
        tenant: member.tenant,
        scope: area.scope,
        facet: "attachment",
        object: `file-data:${projectId}:${publicId(newProductRowId())}:${"a".repeat(32)}:0`,
        revision: "1",
        generation: current.generation,
        policyVersion: permissions.version,
        author: user,
      },
      bytes("{}"),
      knownKey,
      member.identity.signingKey.privateKey,
    );
    assert.ok(
      (
        await memberClient.mutate("zerotrust.fileChunks.put", {
          domain: area.domain,
          envelope: unauthorized,
        })
      )[1],
      "Native authorization denies a validly signed read-only writer too",
    );
    business.dispose();
    await acceptVaultWithKey(root.dataKey, root.vault, root.username, false);
    await changeProjectAccess(
      rootClient,
      user,
      projectId,
      "none",
      signal,
      "attachment",
    );
    await owner.files.save(
      projectId,
      id,
      1n,
      new Blob(["File content written after read access was revoked"]),
    );
    const collection = await protectedCollection(rootClient, area, signal);
    try {
      const entry = (await collection.read()).find(
        (entry) => entry.envelope.object === fileObject(projectId, id),
      )!;
      const manifest = filePayload(
        entry.value,
        entry.envelope.object,
        projectId,
      ).original!;
      for (const packet of [
        entry.envelope,
        await required(
          rootClient.query(
            "zerotrust.fileChunks.get",
            { domain: area.domain, id: manifest.parts[0].id },
            { strategy: "network-only" },
          ),
        ),
      ]) {
        const {
          format: _format,
          nonce: _nonce,
          ciphertext: _ciphertext,
          wrappedKey: _wrappedKey,
          signature: _signature,
          ...context
        } = packet;
        await assert.rejects(
          () =>
            decryptObject(
              packet,
              context,
              knownKey,
              root.identity.signingKey.publicKey,
            ),
          "The revoked reader's old key must not decrypt new manifests or file blocks",
        );
      }
    } finally {
      collection.close();
    }
    await acceptVaultWithKey(member.dataKey, member.vault, member.username, false);
    business = createBusinessClient(memberClient, { productDriver: driver });
    assert.ok((await business.query("projects.files.list", { projectId }))[1]);
    assert.ok(
      (await business.query("projects.get", { id: projectId }))[0],
      "Revoking files does not revoke master data",
    );
    business.dispose();
    await acceptVaultWithKey(root.dataKey, root.vault, root.username, false);
    await changeProjectAccess(
      rootClient,
      user,
      projectId,
      "write",
      signal,
      "attachment",
    );
    await changeProjectAccess(rootClient, user, projectId, "none", signal);
    const sharedRoom = await owner.files.publishOfficeSession(
      projectId,
      id,
      undefined,
      room("c"),
    );
    const oldFile = await owner.files.officeStatus(projectId, id);
    await acceptVaultWithKey(member.dataKey, member.vault, member.username, false);
    business = createBusinessClient(memberClient, { productDriver: driver });
    assert.ok((await business.query("projects.get", { id: projectId }))[1]);
    assert.equal(
      await (await business.files.blob(projectId, id)).text(),
      "File content written after read access was revoked",
    );
    assert.equal(
      (await business.files.officeStatus(projectId, id)).accessKey,
      sharedRoom.editKey,
    );
    const winner = await business.files.publishOfficeSession(
      projectId,
      id,
      undefined,
      room("d"),
    );
    assert.equal(winner.editKey, sharedRoom.editKey);
    assert.equal(winner.epoch, sharedRoom.epoch);
    await business.files.saveOffice(
      projectId,
      id,
      sharedRoom.epoch,
      BigInt(oldFile.contentVersion),
      new Blob(["Edited by a file-only collaborator"]),
    );
    const own = await business.files.upload({
      projectId,
      name: "Neue Datei ohne Grunddatenschlüssel.txt",
      mime: "text/plain",
      blob: new Blob(["No project title key required"]),
    });
    assert.equal(
      await (await business.files.blob(projectId, own)).text(),
      "No project title key required",
    );
    business.dispose();
    await acceptVaultWithKey(root.dataKey, root.vault, root.username, false);
    const confirmedFile = await owner.files.officeStatus(projectId, id);
    assert.equal(oldFile.epoch, sharedRoom.epoch);
    assert.equal(confirmedFile.epoch, sharedRoom.epoch);
    assert.equal(
      BigInt(confirmedFile.contentVersion),
      BigInt(oldFile.contentVersion) + 1n,
    );
    await assert.rejects(
      () =>
        owner.files.saveOffice(
          projectId,
          id,
          sharedRoom.epoch,
          BigInt(oldFile.contentVersion),
          new Blob(["Late export from the same editor room"]),
        ),
      ProtectedWriteConflict,
      "The same room and current edit access do not authorize an old export",
    );
    await changeProjectAccess(rootClient, user, projectId, "read", signal);
    await changeProjectAccess(
      rootClient,
      user,
      projectId,
      "read",
      signal,
      "attachment",
    );
    const previousSession = (await owner.files.officeStatus(projectId, id))
      .previousSession;
    assert.equal(previousSession?.epoch, sharedRoom.epoch);
    assert.equal(previousSession?.viewKey, sharedRoom.viewKey);
    await assert.rejects(
      () =>
        owner.files.publishOfficeSession(projectId, id, undefined, room("e")),
      "A new key context cannot silently restart from the old confirmed file",
    );
    const recoveredDraft = new Blob(
      ["Unconfirmed Office draft recovered after key rotation"],
      { type: "text/plain" },
    );
    for (const changed of [
      { epoch: "0".repeat(32), version: previousSession!.version },
      { epoch: previousSession!.epoch, version: "1" },
    ]) {
      await assert.rejects(() =>
        owner.files.publishOfficeSession(projectId, id, undefined, room("e"), {
          ...changed,
          document: recoveredDraft,
        }),
      );
    }
    assert.equal(
      await (await owner.files.blob(projectId, id)).text(),
      "Edited by a file-only collaborator",
    );
    await acceptVaultWithKey(member.dataKey, member.vault, member.username, false);
    business = createBusinessClient(memberClient, { productDriver: driver });
    const priorRead = await business.files.officeStatus(projectId, id);
    assert.equal(priorRead.canEdit, false);
    assert.equal(
      priorRead.accessKey,
      undefined,
      "A policy change must not attach current readers to an old room that revoked writers can still change",
    );
    assert.equal(priorRead.previousSession, null);
    business.dispose();
    await acceptVaultWithKey(root.dataKey, root.vault, root.username, false);
    const nextRoom = await owner.files.publishOfficeSession(
      projectId,
      id,
      undefined,
      room("e"),
      {
        epoch: previousSession!.epoch,
        version: previousSession!.version,
        document: recoveredDraft,
      },
    );
    assert.notEqual(nextRoom.epoch, sharedRoom.epoch);
    assert.equal(
      await (await owner.files.blob(projectId, id)).text(),
      await recoveredDraft.text(),
    );
    const winningRoom = await owner.files.publishOfficeSession(
      projectId,
      id,
      undefined,
      room("f"),
      {
        epoch: previousSession!.epoch,
        version: previousSession!.version,
        document: new Blob(["Stale losing Office handoff"]),
      },
    );
    assert.equal(winningRoom.epoch, nextRoom.epoch);
    assert.equal(
      await (await owner.files.blob(projectId, id)).text(),
      await recoveredDraft.text(),
      "A losing handoff must not overwrite the already committed draft",
    );
    const adopted = await owner.files.officeStatus(projectId, id);
    const adoptedVersion = BigInt(adopted.contentVersion);
    await assert.rejects(() =>
      owner.files.saveOffice(
        projectId,
        id,
        sharedRoom.epoch,
        adoptedVersion,
        new Blob(["Stale editor after policy change"]),
      ),
    );
    await acceptVaultWithKey(member.dataKey, member.vault, member.username, false);
    business = createBusinessClient(memberClient, { productDriver: driver });
    const downgraded = await business.files.officeStatus(projectId, id);
    assert.equal(downgraded.canEdit, false);
    assert.equal(downgraded.accessKey, nextRoom.viewKey);
    assert.notEqual(downgraded.accessKey, nextRoom.editKey);
    await assert.rejects(() =>
      business!.files.saveOffice(
        projectId,
        id,
        sharedRoom.epoch,
        adoptedVersion,
        new Blob(["Removed writer cannot save"]),
      ),
    );
    business.dispose();
    await acceptVaultWithKey(root.dataKey, root.vault, root.username, false);
    await owner.files.saveOffice(
      projectId,
      id,
      nextRoom.epoch,
      adoptedVersion,
      new Blob(["After ordinary file-only edit"]),
    );
  } finally {
    business?.dispose();
    owner.dispose();
    await acceptVaultWithKey(root.dataKey, root.vault, root.username, false);
  }
  console.log(
    "File grants and private Office sessions verified: independent master/file keys, source bypass denied, read-only signed writes denied, rotation excludes old keys, individually sealed editor capabilities, shared-session winner, read-only downgrade and stale editor-save denial without master-data decryption.",
  );
}

export async function denyUnownedFileArea(
  memberClient: Client,
  signal: AbortSignal,
) {
  await assert.rejects(
    () =>
      createProjectArea(
        memberClient,
        fileCollection(publicId(newProductRowId())),
        signal,
      ),
    "Creation permission cannot allocate a file area without the same creator's published project",
  );
}
