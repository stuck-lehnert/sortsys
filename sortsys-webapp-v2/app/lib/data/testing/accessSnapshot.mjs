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
  const selected = input.domain ? [input.domain] : input.domains;
  if (selected) {
    origins = [];
    for (const domain of selected) {
      const scope = domain.slice(0, domain.lastIndexOf(":"));
      if (!creationResource(scope)) continue;
      const origin = await read("zerotrust.creations.origin", { domain });
      if (origin) origins.push(origin);
    }
  } else {
    origins = await read("zerotrust.creations.list");
  }
  let domains =
    input.includeDomains === false ? [] : await read("zerotrust.domains.list");
  if (selected)
    domains = domains.filter((domain) => selected.includes(domain.id));
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
