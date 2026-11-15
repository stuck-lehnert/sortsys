import { writeFile } from "node:fs/promises";
import { base64, createIdentity, publicIdentity, recoveryCatalogAccessFrame, sign } from "../src/index";

const identity = await createIdentity();
const access = {
  tenant: "laboratory:alpha", generation: "2", targetGeneration: "3", challengeId: "challenge:7",
  challenge: base64(new Uint8Array(32).fill(17)), object: "catalog-page:synthetic-42",
  hash: base64(new Uint8Array(32).fill(23)), action: "write" as const,
};
const frame = recoveryCatalogAccessFrame(access);
await writeFile(new URL("fixtures/recovery-catalog-access.json", import.meta.url), JSON.stringify({
  access, signingKey: (await publicIdentity(identity)).signingKey,
  frame: base64(frame), proof: await sign(identity.signingKey.privateKey, frame),
}, null, 2) + "\n");
