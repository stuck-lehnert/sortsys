import { createDelegatedDomain, createOrigin, PROJECT_MODULE_FACETS, publicSigningKey } from "../src/sortsys";
import { creationFixture } from "./support/creationFixture";
const f = await creationFixture(), definitions = [];
for (const [module, facets] of Object.entries(PROJECT_MODULE_FACETS)) for (const facet of facets) {
  const scope = `project:abc:${module}`;
  const origin = await createOrigin({ ...f.origin, id: `${scope}:${facet}`, scope, facet, parent: f.origin }, f.creator.signingKey.privateKey);
  const { definition } = await createDelegatedDomain({ origin, creatorKey: f.creator.signingKey.privateKey, policyVersion: "1",
    recovery: { encryptionKey: f.setup.authority.recoveryEncryptionKey, signingKey: f.setup.authority.recoverySigningKey } });
  definitions.push(definition);
}
await Bun.write(new URL("../../sortsys-api-v2/rust-api/tests/fixtures/zerotrust-project-modules.json", import.meta.url), JSON.stringify({
  notice: "Public synthetic browser protocol vector; no private keys or recovery phrase.",
  authority: await publicSigningKey(f.authorityKey.publicKey), root: f.definition, definitions,
}, null, 2) + "\n");
