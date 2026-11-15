import { publicSigningKey } from "../src/sortsys";
import { creationFixture } from "./support/creationFixture";

const fixture = await creationFixture();
await Bun.write(new URL("../../sortsys-api-v2/rust-api/tests/fixtures/zerotrust-creation.json", import.meta.url), JSON.stringify({
  notice: "Public synthetic browser protocol vector; no private keys or recovery phrase.",
  authority: await publicSigningKey(fixture.authorityKey.publicKey),
  definition: fixture.definition,
}, null, 2) + "\n");
