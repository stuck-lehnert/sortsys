import { creationResource } from "@sortsys/zerotrust/sortsys";

/** Build the new public transport envelope from existing cryptographic test
 * fixtures. This simulates transport only; native tests exercise transactions. */
export async function accessSnapshotFixture(client, input = {}) {
  const read = async (path, parameters) => {
    const [value, error] = await client.query(path, parameters);
    if (error) throw error;
    return value;
  };
  const session = await read("auth.sessionInfo");
  const history = await read("zerotrust.trust.history");
  const policy = await read("zerotrust.policy.get");
  let origins;
  if (input.domain) {
    const scope = input.domain.slice(0, input.domain.lastIndexOf(":"));
    origins = creationResource(scope)
      ? [
          await read("zerotrust.creations.origin", { domain: input.domain }),
        ].filter(Boolean)
      : [];
  } else {
    origins = await read("zerotrust.creations.list");
  }
  let domains =
    input.includeDomains === false ? [] : await read("zerotrust.domains.list");
  if (input.domain)
    domains = domains.filter((domain) => domain.id === input.domain);
  return [
    {
      subject: `user:${session.user.id}`,
      username: session.user.username,
      history,
      policy,
      origins,
      domains,
    },
    null,
  ];
}
