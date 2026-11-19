import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createClient,
  type Client,
  type MutateInput,
} from "@sortsys/v2-client";
import {
  areaKey,
  accountVaultFrame,
  accountVault,
  base64,
  bytes,
  certifyIdentity,
  digest,
  encryptObject,
  encryptedObject,
  decryptObject,
  frame,
  objectFrame,
  openBox,
  randomSecret,
  sign,
  unbase64,
  utf8,
  type IdentityCertificate,
} from "@sortsys/zerotrust/sortsys";
import {
  createSigningRequest,
  reviewSigningRequest,
  signingRenewalEnrollment,
} from "../app/lib/crypto/signingRenewal";
import {
  commitRecovery,
  recoveryDraft,
  recoveryPlan,
} from "../app/lib/crypto/recovery";
import { initializeTenant } from "../app/lib/crypto/initializeTenant";
import {
  approveMemberInvitation,
  createMemberInvitation,
  joinMemberInvitation,
  signInMemberInvitation,
} from "../app/lib/crypto/invitations";
import {
  acceptVaultWithKey,
  enrollPasswordAccount,
  lockCryptoSession,
  signIn,
  trustedHistory,
  unlockedAccount,
} from "../app/lib/crypto/session";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { PRODUCT_COLLECTION } from "../app/lib/data/products";
import { required } from "../app/lib/data/protectedObjects";
import { duckDriver } from "../app/lib/data/testing/duckDriver.mjs";
import { stockPacket } from "../app/lib/data/stockObjects";

assert.equal(process.env.SORTSYS_DISPOSABLE_AUTH_TEST, "1");
const endpoints: unknown = JSON.parse(
  process.env.SORTSYS_AUTH_TEST_ENDPOINTS ?? "null",
);
assert.ok(Array.isArray(endpoints) && endpoints.length === 2);
for (const endpoint of endpoints) {
  const url = new URL(endpoint);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.protocol, "http:");
}
const [, , outputPath] = process.argv.slice(2);
assert.ok(outputPath);
const tenant = "signing-identity-tenant";
const memberPassword = "Original-signing-member-password-2026!";
const renewedPassword = "Renewed-signing-member-password-2026!";
const privateName = "Vertrauliche Position vor Schlüsselwechsel 482193";
const changedName = "Vertrauliche Position nach Schlüsselwechsel 861247";
const signal = new AbortController().signal;
const owner = createClient(endpoints[0], "signing-owner");
const member = createClient(endpoints[1], "signing-member");
const oldDevice = createClient(endpoints[0], "signing-old-device");
const originalFetch = globalThis.fetch;
const wire: string[] = [];
globalThis.fetch = new Proxy(originalFetch, {
  apply(target, receiver, args) {
    if (typeof args[1]?.body === "string") wire.push(args[1].body);
    const url = new URL(
      args[0] instanceof Request ? args[0].url : String(args[0]),
    );
    for (const value of url.searchParams.values()) wire.push(value);
    return Reflect.apply(target, receiver, args);
  },
});
type Enrollment = MutateInput<"auth.opaque.enrollFinish">;
let mode:
  | "normal"
  | "missing-old"
  | "missing-new"
  | "forged-authority"
  | "discard"
  | "lose-reply" = "normal";
let rewrite: ((input: Enrollment) => Promise<Enrollment>) | undefined;
let submitted = 0;
const observed: Client = {
  ...member,
  mutate: (async (path, input, options) => {
    if (path !== "auth.opaque.enrollFinish")
      return member.mutate(path, input, options);
    submitted++;
    if (mode === "discard") return [{ success: true }, null];
    const payload = structuredClone(input as Enrollment);
    if (mode === "missing-old") payload.previousIdentityProof = null;
    if (mode === "missing-new")
      payload.replacement!.newIdentityProof = base64(new Uint8Array(64));
    if (mode === "forged-authority") {
      assert.ok(rewrite);
      return member.mutate(
        "auth.opaque.enrollFinish",
        await rewrite(payload),
        options,
      );
    }
    const result = await member.mutate(
      "auth.opaque.enrollFinish",
      payload,
      options,
    );
    if (mode === "lose-reply" && !result[1])
      throw new TypeError("Lost identity replacement acknowledgement");
    return result;
  }) as Client["mutate"],
};
try {
  await signIn(owner, {
    tenant,
    username: "builder",
    password: "Only-owner-knows-this-password-2026!",
  });
  await initializeTenant(owner, signal, duckDriver);
  const administrator = unlockedAccount()!;
  await assert.rejects(() => createSigningRequest(owner, signal));
  let business = createBusinessClient(owner, { productDriver: duckDriver });
  const person = await required(
    business.mutate("users.create", {
      username: "key.member",
      firstName: "Signaturwechsel",
      contractType: "internal",
    }),
  );
  business.dispose();
  const invitation = await createMemberInvitation(
    owner,
    { id: person.id, username: "key.member" },
    {
      catalogue: "write",
      customers: "none",
      contacts: "none",
      vendors: "none",
      prices: "none",
      assistant: false,
    },
    signal,
  );
  await signInMemberInvitation(member, invitation.link, memberPassword, signal);
  await joinMemberInvitation(member, invitation.link, signal);
  await acceptVaultWithKey(
    administrator.dataKey,
    administrator.vault,
    administrator.username,
    false,
  );
  await approveMemberInvitation(
    owner,
    invitation.link.invitation.id,
    signal,
    duckDriver,
  );
  await signIn(member, {
    tenant,
    username: "key.member",
    password: memberPassword,
  });
  await signIn(oldDevice, {
    tenant,
    username: "key.member",
    password: memberPassword,
  });
  const previousAccount = unlockedAccount()!;
  const subject = `user:${person.id}`;
  const history = await trustedHistory(member);
  const previous = history.identityCertificate(subject);
  const request = await createSigningRequest(member, signal);
  await assert.rejects(() => reviewSigningRequest(member, request, signal));
  await acceptVaultWithKey(
    administrator.dataKey,
    administrator.vault,
    administrator.username,
    false,
  );
  const tampered = JSON.parse(request);
  tampered.sealedSeed = base64(new Uint8Array(48));
  await assert.rejects(() =>
    reviewSigningRequest(owner, JSON.stringify(tampered), signal),
  );
  const reviewed = await reviewSigningRequest(owner, request, signal);
  assert.equal(reviewed.username, "key.member");
  const approval = await reviewed.approve();
  await assert.rejects(() =>
    signingRenewalEnrollment(owner, approval, renewedPassword, signal),
  );
  await lockCryptoSession();
  await signIn(member, {
    tenant,
    username: "key.member",
    password: memberPassword,
  });
  const enrollment = await signingRenewalEnrollment(
    member,
    approval,
    renewedPassword,
    signal,
  );
  const { identity, replacementCertificate: certificate } = enrollment;
  business = createBusinessClient(member, { productDriver: duckDriver });
  const product = await required(
    business.mutate("products.create", {
      customId: 482193,
      name: privateName,
      baseUnit: "Stk",
    }),
  );
  business.dispose();
  const original = await required(
    member.query(
      "zerotrust.objects.get",
      { id: `product:${product.id}` },
      { strategy: "network-only" },
    ),
  );
  const keys = await required(
    member.query(
      "zerotrust.keys.get",
      { domain: PRODUCT_COLLECTION.domain, generation: original.generation },
      { strategy: "network-only" },
    ),
  );
  const rawKey = await openBox(
    keys,
    {
      tenant,
      purpose: "area-key",
      object: PRODUCT_COLLECTION.domain,
      generation: original.generation,
      recipient: subject,
      author: keys.author,
    },
    previousAccount.identity.encryptionKey.privateKey,
    history.authority(history.current.generation),
  );
  const encryptionKey = await areaKey(rawKey);
  rewrite = async (input) => {
    const forged: IdentityCertificate = await certifyIdentity(
      {
        tenant,
        generation: certificate.generation,
        user: subject,
        encryptionKey: certificate.encryptionKey,
        signingKey: certificate.signingKey,
        previousSignature: previous.signature,
      },
      previousAccount.identity.signingKey.privateKey,
    );
    const message = frame("sortsys/account-enroll/v3", [
      tenant,
      subject,
      input.exchange,
      await digest(unbase64(input.registrationRecord, 4096)),
      await digest(accountVaultFrame(accountVault(input.vault))),
      forged.signature,
    ]);
    return {
      ...input,
      previousIdentityProof: await sign(
        previousAccount.identity.signingKey.privateKey,
        message,
      ),
      replacement: {
        certificate: forged,
        newIdentityProof: await sign(identity.signingKey.privateKey, message),
      },
    };
  };
  // Neither one key holder nor both user keys can replace the authority's approval.
  for (const attack of [
    "missing-old",
    "missing-new",
    "forged-authority",
    "discard",
  ] as const) {
    mode = attack;
    await assert.rejects(() => enrollPasswordAccount(observed, enrollment));
    assert.deepEqual(
      (await trustedHistory(member)).identityCertificate(subject),
      previous,
    );
    assert.equal(
      (
        await required(
          oldDevice.query("auth.sessionInfo", undefined, {
            strategy: "network-only",
          }),
        )
      ).user.id,
      person.id,
    );
  }
  assert.equal(submitted, 4);
  mode = "lose-reply";
  await enrollPasswordAccount(observed, enrollment);
  assert.equal(submitted, 5);
  const current = await trustedHistory(member);
  assert.deepEqual(current.identityCertificate(subject), certificate);
  await assert.rejects(() =>
    signingRenewalEnrollment(member, approval, renewedPassword, signal),
  );
  assert.ok(await current.signer(encryptedObject(original)));
  assert.ok(
    (
      await oldDevice.query("auth.check", undefined, {
        strategy: "network-only",
      })
    )[1],
  );
  business = createBusinessClient(member, { productDriver: duckDriver });
  assert.equal(
    (await required(business.query("products.get", { id: product.id }))).name,
    privateName,
  );
  await required(
    business.mutate("products.update", {
      id: product.id,
      data: { name: changedName },
    }),
  );
  business.dispose();
  const changed = await required(
    member.query(
      "zerotrust.objects.get",
      { id: original.object },
      { strategy: "network-only" },
    ),
  );
  const context = {
    tenant,
    scope: changed.scope,
    facet: changed.facet,
    object: changed.object,
    generation: changed.generation,
    revision: changed.revision,
    policyVersion: changed.policyVersion,
    author: subject,
  };
  const value = JSON.parse(
    utf8(
      await decryptObject(
        changed,
        context,
        encryptionKey,
        identity.signingKey.publicKey,
      ),
    ),
  );
  const stale = await encryptObject(
    { ...context, revision: (BigInt(changed.revision) + 1n).toString() },
    bytes(JSON.stringify(value)),
    encryptionKey,
    previousAccount.identity.signingKey.privateKey,
  );
  const page = await required(
    member.query(
      "zerotrust.objects.list",
      {
        domain: PRODUCT_COLLECTION.domain,
        prefix: "product:",
        after: null,
        snapshot: null,
      },
      { strategy: "network-only" },
    ),
  );
  const heads = [
    { domain: PRODUCT_COLLECTION.domain, sequence: page.snapshot },
  ];
  const [, retired] = await member.mutate("zerotrust.objects.batch", {
    heads,
    objects: [
      {
        domain: PRODUCT_COLLECTION.domain,
        messageId: `msg_${base64(randomSecret())}`,
        envelope: stale,
        references: await stockPacket(
          stale,
          value,
          history.current.generation,
          previousAccount.identity.signingKey.privateKey,
        ),
      },
    ],
  });
  assert.ok(
    retired,
    "A valid ciphertext signed by the retired key cannot publish under the current session",
  );
  assert.equal(
    (
      await required(
        member.query(
          "zerotrust.objects.get",
          { id: original.object },
          { strategy: "network-only" },
        ),
      )
    ).signature,
    changed.signature,
  );
  const accepted = {
    ...stale,
    signature: await sign(identity.signingKey.privateKey, objectFrame(stale)),
  };
  await required(
    member.mutate("zerotrust.objects.batch", {
      heads,
      objects: [
        {
          domain: PRODUCT_COLLECTION.domain,
          messageId: `msg_${base64(randomSecret())}`,
          envelope: accepted,
          references: await stockPacket(
            accepted,
            value,
            history.current.generation,
            identity.signingKey.privateKey,
          ),
        },
      ],
    }),
  );
  await lockCryptoSession();
  await assert.rejects(() =>
    signIn(member, {
      tenant,
      username: "key.member",
      password: memberPassword,
    }),
  );
  await signIn(member, {
    tenant,
    username: "key.member",
    password: renewedPassword,
  });
  assert.equal(
    (await required(member.query("auth.sessionInfo", undefined))).user.id,
    person.id,
  );
  business = createBusinessClient(member, { productDriver: duckDriver });
  assert.equal(
    (await required(business.query("products.get", { id: product.id }))).name,
    changedName,
  );
  business.dispose();
  rawKey.fill(0);
  await acceptVaultWithKey(
    administrator.dataKey,
    administrator.vault,
    administrator.username,
    false,
  );
  const repeatedInvitation = await createMemberInvitation(
    owner,
    { id: person.id, username: "key.member" },
    {
      catalogue: "write",
      customers: "none",
      contacts: "none",
      vendors: "none",
      prices: "none",
      assistant: false,
    },
    signal,
  );
  await signInMemberInvitation(
    member,
    repeatedInvitation.link,
    renewedPassword,
    signal,
  );
  await joinMemberInvitation(member, repeatedInvitation.link, signal);
  await acceptVaultWithKey(
    administrator.dataKey,
    administrator.vault,
    administrator.username,
    false,
  );
  await approveMemberInvitation(
    owner,
    repeatedInvitation.link.invitation.id,
    signal,
    duckDriver,
  );
  assert.equal(
    (await trustedHistory(owner)).identityCertificate(subject).signature,
    certificate.signature,
    "A repeated invitation must retain the current successor certificate",
  );
  const root = process.env.SORTSYS_NATIVE_AUTH_ROOT;
  assert.ok(root);
  const source = JSON.parse(
    await readFile(join(root, "owner-recovery.json"), "utf8"),
  );
  assert.equal(source.tenant, tenant);
  await lockCryptoSession();
  const recoveredPassword = "Recovered-signing-owner-password-2026!";
  const draft = await recoveryDraft(
    owner,
    tenant,
    source.phrase,
    recoveredPassword,
    { restoreAdministrator: true },
  );
  const plan = await recoveryPlan(owner, draft);
  await commitRecovery(owner, plan);
  await signIn(owner, {
    tenant,
    username: plan.username,
    password: recoveredPassword,
  });
  const recovered = await trustedHistory(owner);
  assert.equal(recovered.current.generation, "2");
  assert.equal(
    recovered.identityCertificate(subject, "1").signature,
    certificate.signature,
  );
  assert.ok(await recovered.signer(encryptedObject(original)));
  business = createBusinessClient(owner, { productDriver: duckDriver });
  assert.equal(
    (await required(business.query("products.get", { id: product.id }))).name,
    changedName,
  );
  business.dispose();
  if (process.env.SORTSYS_NATIVE_BROWSER === "1") {
    await initializeTenant(owner, signal, duckDriver);
    const recoveredAdmin = unlockedAccount()!;
    const username = "dialog.member";
    const password = "Original-signing-dialog-password-2026!";
    const replacement = "Renewed-signing-dialog-password-2026!";
    const browserBusiness = createBusinessClient(owner, {
      productDriver: duckDriver,
    });
    const browserMember = await required(
      browserBusiness.mutate("users.create", {
        username,
        firstName: "Dialogprüfung",
        contractType: "internal",
      }),
    );
    browserBusiness.dispose();
    const invitation = await createMemberInvitation(
      owner,
      {
        id: browserMember.id,
        username,
      },
      {
        catalogue: "read",
        customers: "none",
        contacts: "none",
        vendors: "none",
        prices: "none",
        assistant: false,
      },
      signal,
    );
    await signInMemberInvitation(member, invitation.link, password, signal);
    await joinMemberInvitation(member, invitation.link, signal);
    await acceptVaultWithKey(
      recoveredAdmin.dataKey,
      recoveredAdmin.vault,
      recoveredAdmin.username,
      false,
    );
    await approveMemberInvitation(
      owner,
      invitation.link.invitation.id,
      signal,
      duckDriver,
    );
    const browserSubject = `user:${browserMember.id}`;
    const before = (await trustedHistory(owner)).identityCertificate(
      browserSubject,
    );
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "node",
        ["scripts/e2e/signingRenewal.browser.mjs", root],
        {
          stdio: "inherit",
          env: {
            ...process.env,
            SORTSYS_SIGNING_E2E_TENANT: tenant,
            SORTSYS_SIGNING_E2E_PASSWORD: password,
            SORTSYS_SIGNING_E2E_RENEWED: replacement,
            SORTSYS_SIGNING_E2E_ADMIN: plan.username,
            SORTSYS_SIGNING_E2E_ADMIN_PASSWORD: recoveredPassword,
          },
        },
      );
      child.once("error", reject);
      child.once("exit", (status, signal) => {
        if (status === 0) resolve();
        else
          reject(new Error(`Signing dialog test failed: ${signal ?? status}`));
      });
    });
    const after = (await trustedHistory(owner)).identityCertificate(
      browserSubject,
    );
    assert.equal(after.previousSignature, before.signature);
    assert.equal(after.encryptionKey, before.encryptionKey);
    console.log(
      "Signing renewal through the production UI published a verified successor",
    );
  }
  for (const secret of [
    memberPassword,
    renewedPassword,
    privateName,
    changedName,
    source.phrase,
    draft.newPhrase,
    recoveredPassword,
    JSON.parse(request).sealedSeed,
  ]) {
    assert.equal(
      wire.some((request) => request.includes(secret)),
      false,
    );
  }
  await writeFile(
    outputPath,
    JSON.stringify({
      success: true,
      member: person.id,
      historicalSignaturesPreserved: true,
      retiredKeyRejected: true,
      unilateralChangesRejected: true,
      reinvitationPreservedSuccession: true,
      recoveryPreservedSuccession: true,
    }),
  );
} finally {
  globalThis.fetch = originalFetch;
  for (const client of [owner, member, oldDevice]) client.setToken(null);
  await lockCryptoSession();
}
