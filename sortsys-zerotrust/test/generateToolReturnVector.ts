import {
  base64,
  certifyIdentity,
  createIdentity,
  createOrigin,
  createResourceCommandKey,
  creationResourceBinding,
  openResourceCommandSigner,
  publicIdentity,
  publicSigningKey,
  resourceCommandBinding,
  signResourceAccess,
  signResourceCommand,
  TOOL_RETURN_PURPOSE,
} from "../src/sortsys";
import { creationFixture } from "./support/creationFixture";

const fixture = await creationFixture("tool-tracking");
const assignee = await certifyIdentity({
  tenant: fixture.origin.tenant,
  generation: fixture.origin.capability.generation,
  user: "user:3",
  ...await publicIdentity(await createIdentity()),
}, fixture.authorityKey.privateKey);
const origin = await createOrigin(
  { ...fixture.origin, assignee },
  fixture.creator.signingKey.privateKey,
);
const key = await createResourceCommandKey();
const fields = {
  tenant: origin.tenant,
  resource: origin.scope,
  object: `${origin.scope}:master-data:record`,
  generation: origin.capability.generation,
  binding: await creationResourceBinding(origin),
  commandBinding: await resourceCommandBinding(key.verificationKey),
  author: origin.capability.creator,
};
const active = await signResourceAccess({
  ...fields,
  revision: "7",
  active: true,
  packetSignature: base64(new Uint8Array(64).fill(1)),
}, fixture.creator.signingKey.privateKey);
const closed = await signResourceAccess({
  ...fields,
  revision: "8",
  active: false,
  packetSignature: base64(new Uint8Array(64).fill(2)),
}, fixture.creator.signingKey.privateKey);
const returned = await signResourceCommand({
  tenant: origin.tenant,
  purpose: TOOL_RETURN_PURPOSE,
  revision: active.revision,
  issuedAt: "1795046400000",
  verificationKey: key.verificationKey,
}, await openResourceCommandSigner(key));

const output = new URL(
  "../../sortsys-api-v2/rust-api/tests/fixtures/zerotrust-tool-return.json",
  import.meta.url,
);
await Bun.write(output, JSON.stringify({
  notice: "Öffentlicher Browser-Testvektor für eine Werkzeugrückgabe. Enthält keine privaten Schlüssel.",
  authority: await publicSigningKey(fixture.authorityKey.publicKey),
  origin,
  active,
  returned,
  closed,
}, null, 2) + "\n");
