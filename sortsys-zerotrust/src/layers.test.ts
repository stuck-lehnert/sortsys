import { expect, test } from "bun:test";
import { areaKey } from "./identity";
import { bytes, frame, randomSecret, utf8 } from "./encoding";
import { openLayer, sealLayer } from "./layers";

test("opaque XML parts require all independent area keys without repeated base64 expansion", async () => {
  const keys = await Promise.all(Array.from({ length: 9 }, () => areaKey(randomSecret())));
  const context = (index: number) => frame("sortsys/commercial-opaque-layer/v1", ["tenant", "commercial:4", String(index), "document:5:chunk:0", "1"]);
  let sealed = bytes("Unbekannter Kalkulationspreis 592.00");
  const originalLength = sealed.length;
  for (let i = 0; i < keys.length; i++) sealed = await sealLayer(sealed, keys[i]!, context(i));
  expect(sealed.length).toBe(originalLength + 9 * 68);
  let opened = sealed;
  for (let i = keys.length - 1; i >= 0; i--) opened = await openLayer(opened, keys[i]!, context(i));
  expect(utf8(opened)).toBe("Unbekannter Kalkulationspreis 592.00");
  for (let missing = 0; missing < keys.length; missing++) {
    const wrong = keys.slice(); wrong[missing] = await areaKey(randomSecret());
    await expect((async () => { let value = sealed; for (let i = wrong.length - 1; i >= 0; i--) value = await openLayer(value, wrong[i]!, context(i)); })()).rejects.toThrow();
  }
});
test("opaque layers reject object, generation, tenant, wrapped-key, nonce and ciphertext substitutions", async () => {
  const key = await areaKey(randomSecret()), aad = frame("opaque-test", ["tenant", "object:1", "generation:1"]), sealed = await sealLayer(bytes("879.25"), key, aad);
  for (const other of [["other", "object:1", "generation:1"], ["tenant", "object:2", "generation:1"], ["tenant", "object:1", "generation:2"]])
    await expect(openLayer(sealed, key, frame("opaque-test", other))).rejects.toThrow();
  for (const offset of [0, 40, 52, sealed.length - 1]) {
    const changed = sealed.slice(); changed[offset] = changed[offset]! ^ 1; await expect(openLayer(changed, key, aad)).rejects.toThrow();
  }
  await expect(openLayer(new Uint8Array(67), key, aad)).rejects.toThrow();
  await expect(sealLayer(new Uint8Array(2 * 1024 * 1024 + 1), key, aad)).rejects.toThrow();
});
