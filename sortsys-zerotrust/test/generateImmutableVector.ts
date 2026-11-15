import {
  areaKey,
  bytes,
  createIdentity,
  encryptObject,
  encryptTombstone,
  objectTimestampTarget,
  objectWriteAction,
  publicIdentity,
  immutableRecord,
  FACETS,
  immutableObject,
  type ObjectContext,
} from "../src/sortsys";

const identity = await createIdentity();
const signer = await publicIdentity(identity);
const key = await areaKey();
const context: ObjectContext = {
  tenant: "test",
  scope: "project:2",
  facet: "billing",
  object: "immutable:project:2:billing:financial-invoice:3",
  revision: "1",
  generation: "1",
  policyVersion: "1",
  author: "user:1",
};
const changes = [
  {},
  ...FACETS.map((facet) => ({
    facet,
    object: immutableObject("project:2", facet, "record", "3"),
  })),
  {
    scope: "organization",
    facet: "billing",
    object: "immutable:organization:billing:invoice-number:operation_3",
  },
  {
    scope: "absence:2",
    facet: "master-data",
    object: "immutable:absence:2:master-data:record:3",
  },
  { object: "ordinary-record" },
  { scope: "project:4" },
  { facet: "master-data" },
  { object: context.object + ":extra" },
  { object: "immutable:project:2:billing:Invoice:3" },
  { object: "immutable:project:2:billing:invoice:" },
  { revision: "2" },
] as const;
const cases = [];
for (const change of changes) {
  const binding = { ...context, ...change } as ObjectContext;
  const envelope = await encryptObject(
    binding,
    bytes("{}"),
    key,
    identity.signingKey.privateKey,
  );
  let action: string | null = null;
  let permanent: boolean | null = null;
  let target: Awaited<ReturnType<typeof objectTimestampTarget>> = null;
  try {
    action = objectWriteAction(envelope);
    permanent = immutableRecord(envelope) !== null;
    target = await objectTimestampTarget(
      envelope,
      identity.signingKey.publicKey,
    );
  } catch {}
  cases.push({ envelope, action, permanent, target });
}
const deletion = await encryptTombstone(
  { ...context, revision: "2" },
  key,
  identity.signingKey.privateKey,
);
cases.push({ envelope: deletion, action: null, permanent: null, target: null });
process.stdout.write(
  JSON.stringify({ signer: signer.signingKey, cases }, null, 2) + "\n",
);
