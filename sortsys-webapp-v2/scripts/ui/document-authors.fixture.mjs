import { commercialDocumentStore } from "../../app/lib/data/commercialDocumentContent";
import { createDocumentHeadFixture } from "../../app/lib/data/testing/documentHeads.mjs";
import { lockCryptoSession } from "../../app/lib/crypto/session";

/** Exercise the application's store with real certificates, keys and proofs.
 * Only the storage transport is simulated; the browser verifies every author. */
export async function documentAuthorScenario() {
  const current = await createDocumentHeadFixture();
  const forged = await current.head(null, {}, true);
  const store = await commercialDocumentStore(
    current.tenant.client,
    current.scope,
    new AbortController().signal,
  );
  let readerRejected = false;
  let directLoadRejected = false;
  let renderCalls = 0;
  try {
    try {
      await store.head(forged.id);
    } catch {
      readerRejected = true;
    }
    try {
      await store.load(forged, {
        async render() {
          renderCalls += 1;
          throw new Error(
            "An unauthorized head must never reach XML rendering",
          );
        },
      });
    } catch {
      directLoadRejected = true;
    }
    const valid = await current.head();
    const checked = await store.head(valid.id);
    return {
      readerRejected,
      directLoadRejected,
      writerAccepted: checked?.signature === valid.signature,
      renderCalls,
      keyReads: current.counts().keyReads,
    };
  } finally {
    store.close();
    lockCryptoSession();
  }
}
