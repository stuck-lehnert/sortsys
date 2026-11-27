import { describe, expect, test } from "bun:test";
import { areaKey, base64, bytes, createIdentity, createRecoveryPhrase, decryptObject, encryptObject, fingerprint, frame, importSigningKey, InvalidProtectedData, normalizeRecoveryPhrase, openBox, publicIdentity, randomSecret, recoveryIdentity, sealBox, unbase64, utf8, verify } from "../src/sortsys";
import type { BoxContext, ObjectContext } from "../src/sortsys";

const object: ObjectContext = { tenant: "test", scope: "project:123", facet: "calculation", object: "line:456", revision: "1", generation: "1", policyVersion: "1", author: "user:1" };

describe("protected objects", () => {
  test("native payload round-trip, independent prices and measure keys", async () => {
    const identity = await createIdentity();
    const calculation = await areaKey();
    const measure = await areaKey();
    const plaintext = bytes('<Price currency="EUR">592.00</Price>');
    const encrypted = await encryptObject(object, plaintext, calculation, identity.signingKey.privateKey);
    expect(JSON.stringify(encrypted)).not.toContain("592.00");
    expect(await decryptObject(encrypted, object, calculation, identity.signingKey.publicKey)).toEqual(plaintext);
    await expect(decryptObject(encrypted, object, measure, identity.signingKey.publicKey)).rejects.toBeInstanceOf(InvalidProtectedData);
  });

  test("fresh data keys and ciphertexts even for identical content", async () => {
    const identity = await createIdentity();
    const key = await areaKey();
    const a = await encryptObject(object, bytes("592.00"), key, identity.signingKey.privateKey);
    const b = await encryptObject(object, bytes("592.00"), key, identity.signingKey.privateKey);
    expect(a.wrappedKey).not.toBe(b.wrappedKey);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  test("rejects substitution of every signed header, extra properties and an untrusted signer", async () => {
    const identity = await createIdentity();
    const key = await areaKey();
    const encrypted = await encryptObject(object, bytes("secret"), key, identity.signingKey.privateKey);
    for (const field of ["tenant", "scope", "facet", "object", "revision", "generation", "policyVersion", "author", "nonce", "ciphertext", "wrappedKey", "signature"] as const) {
      const changed = { ...encrypted, [field]: field === "facet" ? "measurement" : "modified" };
      await expect(decryptObject(changed, object, key, identity.signingKey.publicKey)).rejects.toBeInstanceOf(InvalidProtectedData);
    }
    await expect(decryptObject({ ...encrypted, price: "123" }, object, key, identity.signingKey.publicKey)).rejects.toBeInstanceOf(InvalidProtectedData);
    await expect(decryptObject(encrypted, { ...object, tenant: "other" }, key, identity.signingKey.publicKey)).rejects.toBeInstanceOf(InvalidProtectedData);
    await expect(decryptObject(encrypted, object, key, (await createIdentity()).signingKey.publicKey)).rejects.toBeInstanceOf(InvalidProtectedData);
  });

  test("old key cannot read a new generation", async () => {
    const identity = await createIdentity();
    const old = await areaKey();
    const current = await areaKey();
    const context = { ...object, generation: "2", revision: "2", policyVersion: "2" };
    const encrypted = await encryptObject(context, bytes("future price"), current, identity.signingKey.privateKey);
    await expect(decryptObject(encrypted, context, old, identity.signingKey.publicKey)).rejects.toBeInstanceOf(InvalidProtectedData);
    expect(utf8(await decryptObject(encrypted, context, current, identity.signingKey.publicKey))).toBe("future price");
  });

  test("repeated openings reuse only the exact ciphertext signature proof", async () => {
    const identity = await createIdentity();
    const signer = identity.signingKey.publicKey;
    const area = await areaKey();
    const plain = bytes("Sanierung der Halle");
    const encrypted = await encryptObject(
      object,
      plain,
      area,
      identity.signingKey.privateKey,
    );
    const verify = crypto.subtle.verify;
    const decrypt = crypto.subtle.decrypt;
    let signatureChecks = 0;
    let decryptions = 0;

    crypto.subtle.verify = (...args) => {
      signatureChecks++;
      return verify.apply(crypto.subtle, args);
    };
    crypto.subtle.decrypt = (...args) => {
      decryptions++;
      return decrypt.apply(crypto.subtle, args);
    };

    try {
      const results = await Promise.all([
        decryptObject(encrypted, object, area, signer),
        decryptObject({ ...encrypted }, object, area, { candidates: [signer] }),
      ]);
      expect(results).toEqual([plain, plain]);
      expect(signatureChecks).toBe(1);
      expect(decryptions).toBe(2);

      const tampered = unbase64(encrypted.ciphertext);
      tampered[0] = tampered[0]! ^ 1;
      const changed = { ...encrypted, ciphertext: base64(tampered) };
      await expect(
        decryptObject(changed, object, area, signer),
      ).rejects.toBeInstanceOf(InvalidProtectedData);
      expect(signatureChecks).toBe(2);
      expect(decryptions).toBe(2);

      const otherSigner = (await createIdentity()).signingKey.publicKey;
      const differentContext = { ...object, generation: "2" };
      await expect(
        decryptObject(encrypted, object, area, { candidates: [otherSigner] }),
      ).rejects.toBeInstanceOf(InvalidProtectedData);
      await expect(
        decryptObject(encrypted, differentContext, area, signer),
      ).rejects.toBeInstanceOf(InvalidProtectedData);
      await expect(
        decryptObject(encrypted, object, await areaKey(), signer),
      ).rejects.toBeInstanceOf(InvalidProtectedData);

      expect(await decryptObject(encrypted, object, area, signer)).toEqual(plain);
      expect(signatureChecks).toBe(3);
      expect(decryptions).toBe(3);
    } finally {
      crypto.subtle.verify = verify;
      crypto.subtle.decrypt = decrypt;
    }
  });
});

describe("public-key envelopes", () => {
  test("only the intended recipient opens the package and context cannot be changed", async () => {
    const sender = await createIdentity();
    const recipient = await createIdentity();
    const other = await createIdentity();
    const context: BoxContext = { tenant: "test", purpose: "area-key", object: "project:123/calculation", generation: "1", recipient: "user:2", author: "user:1" };
    const secret = randomSecret();
    const encrypted = await sealBox(context, secret, recipient.encryptionKey.publicKey, sender.signingKey.privateKey);
    expect(await openBox(encrypted, context, recipient.encryptionKey.privateKey, sender.signingKey.publicKey)).toEqual(secret);
    await expect(openBox(encrypted, context, other.encryptionKey.privateKey, sender.signingKey.publicKey)).rejects.toBeInstanceOf(InvalidProtectedData);
    await expect(openBox(encrypted, { ...context, purpose: "live-llm-context" }, recipient.encryptionKey.privateKey, sender.signingKey.publicKey)).rejects.toBeInstanceOf(InvalidProtectedData);
    await expect(openBox({ ...encrypted, recipient: "user:3" }, context, recipient.encryptionKey.privateKey, sender.signingKey.publicKey)).rejects.toBeInstanceOf(InvalidProtectedData);
  });
});

describe("recovery secret", () => {
  test("24-word phrase derives stable keys separated by tenant and generation", async () => {
    const phrase = createRecoveryPhrase();
    expect(phrase.split(" ")).toHaveLength(24);
    expect(normalizeRecoveryPhrase(` ${phrase.toUpperCase().replaceAll(" ", "\n")} `)).toBe(phrase);
    const a = await publicIdentity(await recoveryIdentity(phrase, "test", "1"));
    expect(await publicIdentity(await recoveryIdentity(phrase, "test", "1"))).toEqual(a);
    expect(await publicIdentity(await recoveryIdentity(phrase, "other", "1"))).not.toEqual(a);
    expect(await publicIdentity(await recoveryIdentity(phrase, "test", "2"))).not.toEqual(a);
    expect(await publicIdentity(await recoveryIdentity(createRecoveryPhrase(), "test", "1"))).not.toEqual(a);
  });

  test("missing words and checksum errors fail locally", () => {
    const phrase = createRecoveryPhrase();
    expect(() => normalizeRecoveryPhrase(phrase.split(" ").slice(1).join(" "))).toThrow(InvalidProtectedData);
    expect(() => normalizeRecoveryPhrase(Array(24).fill("abandon").join(" "))).toThrow(InvalidProtectedData);
  });

  test("old phrase cannot open new recovery packages", async () => {
    const old = await recoveryIdentity(createRecoveryPhrase(), "test", "1");
    const next = await recoveryIdentity(createRecoveryPhrase(), "test", "2");
    const author = await createIdentity();
    const context: BoxContext = { tenant: "test", purpose: "recovery-catalog", object: "catalog", generation: "2", recipient: "recovery:2", author: "user:1" };
    const encrypted = await sealBox(context, bytes("current keys"), next.encryptionKey.publicKey, author.signingKey.privateKey);
    await expect(openBox(encrypted, context, old.encryptionKey.privateKey, author.signingKey.publicKey)).rejects.toBeInstanceOf(InvalidProtectedData);
    expect(utf8(await openBox(encrypted, context, next.encryptionKey.privateKey, author.signingKey.publicKey))).toBe("current keys");
  });
});

test("base64url decoding preserves every byte and enforces its size and alphabet", () => {
  const content = Uint8Array.from({ length: 0x4001 }, (_, index) => index % 256);
  const encoded = base64(content);

  expect(unbase64(encoded, content.length)).toEqual(content);
  expect(unbase64("", 0)).toEqual(new Uint8Array());
  expect(() => unbase64(encoded, content.length - 1)).toThrow(InvalidProtectedData);
  expect(() => unbase64("Zg\n")).toThrow(InvalidProtectedData);
  expect(() => unbase64("+w")).toThrow(InvalidProtectedData);
});

test("wire encoding rejects noncanonical base64 and frames are unambiguous", async () => {
  expect(() => unbase64("Zh")).toThrow(InvalidProtectedData);
  expect(() => unbase64("Zg==")).toThrow(InvalidProtectedData);
  expect(base64(unbase64("Zg"))).toBe("Zg");
  expect(frame("a", ["bc", "d"])).not.toEqual(frame("a", ["b", "cd"]));
  const identity = await createIdentity();
  const pub = await publicIdentity(identity);
  expect(await fingerprint(pub)).toHaveLength(43);
  const signature = base64(await crypto.subtle.sign("Ed25519", identity.signingKey.privateKey, bytes("message")));
  await verify(await importSigningKey(pub.signingKey), signature, bytes("message"));
});
