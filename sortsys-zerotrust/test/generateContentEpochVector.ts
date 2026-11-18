import { writeFile } from "node:fs/promises";
import {
  base64,
  contentEpochFingerprint,
  contentEpochFrame,
  contentPinKey,
  createIdentity,
  namespaceRecord,
  publicIdentity,
  signContentEpoch,
} from "../src/index";

const original = await createIdentity(),
  current = await createIdentity();
const first = await signContentEpoch(
  {
    format: "zt-content-epoch-v1",
    tenant: "laboratory",
    authorityGeneration: "1",
    number: "1",
    previous: null,
    sourceNumber: "0",
    sourceHead: null,
    snapshot: base64(new Uint8Array(32).fill(1)),
    actor: "researcher:admin",
  },
  original.signingKey.privateKey,
);
const second = await signContentEpoch(
  {
    ...first,
    authorityGeneration: "2",
    number: "2",
    previous: await contentEpochFingerprint(first),
    sourceNumber: "1",
    sourceHead: await contentEpochFingerprint(first),
    snapshot: base64(new Uint8Array(32).fill(2)),
  },
  current.signingKey.privateKey,
);
const third = await signContentEpoch(
  { ...second, number: "3", previous: await contentEpochFingerprint(second) },
  current.signingKey.privateKey,
);
const logical = { collection: "notes", key: "record:01" };
const physical = namespaceRecord(logical, "2");
await writeFile(
  new URL("fixtures/content-epochs.json", import.meta.url),
  JSON.stringify(
    {
      authorities: {
        "1": (await publicIdentity(original)).signingKey,
        "2": (await publicIdentity(current)).signingKey,
      },
      epochs: [first, second, third],
      frames: [first, second, third].map((value) =>
        base64(contentEpochFrame(value)),
      ),
      fingerprints: await Promise.all(
        [first, second, third].map(contentEpochFingerprint),
      ),
      logical,
      physical,
      pin: {
        format: "zt-content-pin-v1",
        record: logical,
        number: "2",
        physical,
      },
      pinKey: await contentPinKey(logical),
    },
    null,
    2,
  ) + "\n",
);
