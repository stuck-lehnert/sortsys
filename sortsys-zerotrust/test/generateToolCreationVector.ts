import { publicSigningKey } from "../src";
import { creationFixture } from "./support/creationFixture";

const vectors = [];
for (const namespace of ["tool", "tool-tracking"] as const) {
  const fixture = await creationFixture(namespace);
  vectors.push({ authority: await publicSigningKey(fixture.authorityKey.publicKey), definition: fixture.definition });
}
await Bun.write(new URL("../../sortsys-api-v2/rust-api/tests/fixtures/zerotrust-tool-creation.json", import.meta.url), JSON.stringify({
  notice: "Öffentliche synthetische Browser-Testvektoren ohne private Schlüssel oder Recovery-Phrase.", vectors,
}, null, 2) + "\n");
