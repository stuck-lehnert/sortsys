import assert from "node:assert/strict";
import { createClient } from "@sortsys/v2-client";
import { signPolicy } from "@sortsys/zerotrust/sortsys";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { createProtectedProjectFiles } from "../app/lib/data/projectFiles";
import { required } from "../app/lib/data/protectedObjects";
import { fileCollection } from "../app/lib/data/projectFileData";
import { duckDriver } from "../app/lib/data/testing/duckDriver.mjs";
import { initializeTenant } from "../app/lib/crypto/initializeTenant";
import { administratorPolicyContext } from "../app/lib/crypto/administration";
import { changeProjectAccess } from "../app/lib/crypto/permissions";
import {
  acceptVaultWithKey,
  lockCryptoSession,
  signIn,
  unlockedAccount,
} from "../app/lib/crypto/session";
import {
  approveMemberInvitation,
  createMemberInvitation,
  joinMemberInvitation,
  signInMemberInvitation,
} from "../app/lib/crypto/invitations";

assert.equal(process.env.SORTSYS_DISPOSABLE_AUTH_TEST, "1");
const endpoints: unknown = JSON.parse(
  process.env.SORTSYS_AUTH_TEST_ENDPOINTS ?? "null",
);
assert.ok(Array.isArray(endpoints) && endpoints.length === 2);
for (const endpoint of endpoints) {
  const url = new URL(endpoint);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.protocol, "http:");
}
const owner = createClient(endpoints[0], "document-search-owner");
const member = createClient(endpoints[1], "document-search-member");
const signal = new AbortController().signal;
const tenant = process.env.SORTSYS_NATIVE_AUTH_TENANT;
assert.equal(tenant, "document-search-tenant");
const login = {
  tenant,
  username: "builder",
  password: "Only-owner-knows-this-password-2026!",
};
const query = "Fenster Wand";
const searchInput = { query, limit: 50n };
const secret = "VERTRAULICHER_SUCHINHALT_519842";
const originalFetch = globalThis.fetch;
const requests: string[] = [];
globalThis.fetch = new Proxy(originalFetch, {
  apply(target, receiver, args) {
    if (typeof args[1]?.body === "string") requests.push(args[1].body);
    return Reflect.apply(target, receiver, args);
  },
});
let ownerBusiness: ReturnType<typeof createBusinessClient> | undefined;
let memberBusiness: ReturnType<typeof createBusinessClient> | undefined;
try {
  await signIn(owner, login);
  await initializeTenant(owner, signal, duckDriver);
  ownerBusiness = createBusinessClient(owner, { productDriver: duckDriver });
  const person = await required(
    ownerBusiness.mutate("users.create", {
      username: "document.reader",
      firstName: "Dokument",
      lastName: "Leser",
    }),
  );
  const invitation = await createMemberInvitation(
    owner,
    { id: person.id, username: "document.reader" },
    {
      catalogue: "none",
      customers: "none",
      contacts: "none",
      vendors: "none",
      prices: "none",
      assistant: false,
    },
    signal,
  );
  await signInMemberInvitation(
    member,
    invitation.link,
    "Document-search-member-password-519842!",
    signal,
  );
  await joinMemberInvitation(member, invitation.link, signal);
  await signIn(owner, login);
  await approveMemberInvitation(
    owner,
    invitation.link.invitation.id,
    signal,
    duckDriver,
  );
  await signIn(member, {
    tenant: login.tenant,
    username: "document.reader",
    password: "Document-search-member-password-519842!",
  });
  const reader = unlockedAccount()!;
  await signIn(owner, login);
  const administrator = unlockedAccount()!;
  // A sign-in changed the owner's data lifetime; use its current facade.
  ownerBusiness.dispose();
  ownerBusiness = createBusinessClient(owner, { productDriver: duckDriver });
  const visible = await required(
    ownerBusiness.mutate("projects.create", {
      title: "Freigegebene Suchbaustelle 519842",
    }),
  );
  const hidden = await required(
    ownerBusiness.mutate("projects.create", {
      title: "Vertrauliche Kalkulation 519842",
    }),
  );
  async function upload(projectId: string, name: string, text: string) {
    return ownerBusiness!.files.upload({
      projectId,
      name,
      mime: "text/plain",
      blob: new Blob([text]),
      inspect: async () => ({ text }),
    });
  }
  const dense = await upload(
    visible.id,
    "Ausführung.txt",
    "Vorbemerkung. ".repeat(100) +
      "Fenster neben den Wänden einbauen. " +
      secret,
  );
  const sparse = await upload(
    visible.id,
    "Anlage.txt",
    "Fenster " + "Bauabschnitt ".repeat(100) + "Wände",
  );
  const forbidden = await upload(
    hidden.id,
    "Vertrauliche Preise.txt",
    "Fenster Wände " + secret,
  );
  assert.equal(
    (await required(ownerBusiness.query("projects.files.search", searchInput)))
      .length,
    3,
  );
  await acceptVaultWithKey(reader.dataKey, reader.vault, false);
  memberBusiness = createBusinessClient(member, { productDriver: duckDriver });
  assert.deepEqual(
    await required(memberBusiness.query("projects.files.search", searchInput)),
    [],
  );
  assert.ok(
    (
      await memberBusiness.query("projects.files.search", {
        ...searchInput,
        projectId: visible.id,
      })
    )[1],
  );
  memberBusiness.dispose();
  await acceptVaultWithKey(administrator.dataKey, administrator.vault, false);
  await changeProjectAccess(
    owner,
    `user:${person.id}`,
    visible.id,
    "read",
    signal,
    "attachment",
  );
  const context = await administratorPolicyContext(owner, signal);
  const revocation = await signPolicy(
    {
      ...context.permissions,
      version: (BigInt(context.permissions.version) + 1n).toString(),
      rules: context.permissions.rules.filter(
        (rule) =>
          !(
            rule.subject === `user:${person.id}` &&
            rule.scope === fileCollection(visible.id).scope &&
            rule.facet === "attachment"
          ),
      ),
    },
    context.authority,
  );
  await acceptVaultWithKey(reader.dataKey, reader.vault, false);
  memberBusiness = createBusinessClient(member, { productDriver: duckDriver });
  const results = await required(
    memberBusiness.query("projects.files.search", searchInput),
  );
  assert.deepEqual(
    results.map((result) => result.id),
    [dense, sparse],
  );
  assert.equal(
    results.some((result) => result.id === forbidden),
    false,
  );
  assert.equal(
    results[0]!.projectTitle,
    "",
    "A file grant must not decrypt unrelated project master data",
  );
  assert.match(results[0]!.excerpt!.text, /Fenster neben den Wänden/);
  assert.ok(results[0]!.excerpt!.text.startsWith("… "));
  const excluded = await required(
    memberBusiness.query("projects.files.search", {
      query: 'Wand -"Fenster neben"',
      limit: 50n,
    }),
  );
  assert.deepEqual(
    excluded.map((result) => result.id),
    [sparse],
  );
  // The other API applies an already signed public change while the reader's
  // account and cached search data remain open. No client-side logout or mock
  // access notice makes this negative check pass.
  await required(owner.mutate("zerotrust.policy.replace", revocation));
  const emptyFiles = createProtectedProjectFiles(
    member,
    signal,
    async () => {
      throw new Error(
        "Refreshing an empty file inventory must not read project master data",
      );
    },
    duckDriver,
  );
  try {
    await emptyFiles.refresh();
  } finally {
    await emptyFiles.close();
  }
  assert.deepEqual(
    await required(memberBusiness.query("projects.files.search", searchInput)),
    [],
  );
  assert.ok(
    (
      await memberBusiness.query("projects.files.search", {
        ...searchInput,
        projectId: visible.id,
      })
    )[1],
  );
  const wire = requests.join("\n");
  for (const privateText of [
    query,
    secret,
    "Vertrauliche Preise.txt",
    "Freigegebene Suchbaustelle 519842",
  ]) {
    assert.equal(
      wire.includes(privateText),
      false,
      "Search terms, document contents and file names must stay client-side",
    );
  }
  console.log(
    "Native document search verified across two APIs: local inflections, phrases, ranking, excerpts, denied files and master data, and immediate revocation with an already populated client cache.",
  );
} finally {
  globalThis.fetch = originalFetch;
  memberBusiness?.dispose();
  ownerBusiness?.dispose();
  await lockCryptoSession();
  owner.setToken(null);
  member.setToken(null);
}
