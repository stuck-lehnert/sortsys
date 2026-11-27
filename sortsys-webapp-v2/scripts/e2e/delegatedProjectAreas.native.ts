import assert from "node:assert/strict";
import { createClient, type Client } from "@sortsys/v2-client";
import { changeProjectCreation } from "../../app/lib/crypto/permissions";
import { lockCryptoSession, signIn } from "../../app/lib/crypto/session";
import { createBusinessClient } from "../../app/lib/data/businessClient";
import { createResourceAreas } from "../../app/lib/data/createProjectArea";
import { newProductRowId, publicId } from "../../app/lib/data/products";
import { projectAccessArea } from "../../app/lib/data/projectScope";
import { required } from "../../app/lib/data/protectedObjects";
import { duckDriver } from "../../app/lib/data/testing/duckDriver.mjs";
import { enrollToolResponsibleMember } from "../test-native-tool-recovery";

assert.equal(process.env.SORTSYS_DISPOSABLE_AUTH_TEST, "1");
assert.equal(process.env.SORTSYS_AUTH_E2E_OPERATOR_PASSWORD, undefined);

const {
  SORTSYS_AUTH_E2E_API: endpoint,
  SORTSYS_AUTH_E2E_USERNAME: login,
  SORTSYS_AUTH_E2E_PASSWORD: password,
  SORTSYS_DELEGATED_MEMBER_PASSWORD: memberPassword,
} = process.env;
assert.ok(endpoint && login && password && memberPassword);

const api = new URL(endpoint);
assert.equal(api.protocol, "http:");
assert.equal(api.hostname, "127.0.0.1");
assert.equal(api.href, `${api.origin}/`);

const [username, tenant, extra] = login.split("@");
assert.ok(username && tenant && extra === undefined);

const signal = new AbortController().signal;
const fresh = { strategy: "network-only" } as const;
const memberName = "module.builder";
const member = createClient(api.href, "delegated-project-member");
const owner = createClient(api.href, "delegated-project-owner");

try {
  if (process.argv[2] === "prepare") {
    const ownerLogin = { tenant, username, password };
    await signIn(owner, ownerLogin);

    const business = createBusinessClient(owner, { productDriver: duckDriver });
    const person = await (async () => {
      try {
        return await required(business.mutate("users.create", {
          username: memberName,
          firstName: "Planung",
          lastName: "Projektbereiche",
          email: null,
          phone: null,
          costPerHour: 0,
          vacationDaysPerYear: 28,
          contractType: "internal",
          supervisorUserId: null,
        }));
      } finally {
        business.dispose();
      }
    })();

    await enrollToolResponsibleMember(owner, member, { id: person.id, username: memberName }, ownerLogin, memberPassword);
    await signIn(owner, ownerLogin);
    await changeProjectCreation(owner, `user:${person.id}`, true, signal);
  } else {
    assert.equal(process.argv[2], "compare");
    await signIn(member, { tenant, username: memberName, password: memberPassword });

    const session = await required(member.query("auth.sessionInfo", undefined, fresh));
    assert.ok(!session.roles.includes(":admin"));
    const subject = `user:${session.user.id}`;

    const id = publicId(newProductRowId());
    const root = projectAccessArea(id, "master-data");
    const modules = [
      projectAccessArea(id, "planning:master-data"),
      projectAccessArea(id, "daily-reports:master-data"),
      projectAccessArea(id, "tool-usage:master-data"),
    ];
    const definition = (domain: string) => required(member.query(
      "zerotrust.domains.get", { domain, generation: "1" }, fresh,
    ));

    await createResourceAreas(member, [root], "project", signal);
    const parent = (await definition(root.domain)).creation;

    assert.ok(parent);
    assert.equal(parent.capability.creator.user, subject);

    let parentReads = 0;
    const counted: Client = {
      ...member,
      query: (path, input, options) => {
        if (path === "zerotrust.domains.get") parentReads++;
        return member.query(path, input, options);
      },
    };
    await createResourceAreas(counted, modules, "project", signal);

    for (const area of modules) {
      const saved = await definition(area.domain);
      assert.equal(saved.id, area.domain);
      assert.equal(saved.scope, area.scope);
      assert.equal(saved.facet, area.facet);
      assert.deepEqual(saved.creation?.parent, parent);
    }

    assert.equal(parentReads, Number(process.argv[3]));
    console.log(`Delegated project modules: ${modules.length} read back, ${parentReads} parent reads`);
  }
} finally {
  await lockCryptoSession();
  owner.setToken(null);
  member.setToken(null);
}
