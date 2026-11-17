import { identitySuccessionFixture } from "./support/identitySuccessionFixture";

const fixture = await identitySuccessionFixture();
await Bun.write(
  new URL("./fixtures/identity-succession.json", import.meta.url),
  JSON.stringify(
    {
      notice:
        "Synthetic public certificates and signed ciphertext only; no private keys or recovery phrases.",
      authority: fixture.setup.authority,
      initial: fixture.initial,
      next: fixture.next,
      latest: fixture.latest,
      oldObject: fixture.oldObject,
      newObject: fixture.newObject,
    },
    null,
    2,
  ) + "\n",
);
