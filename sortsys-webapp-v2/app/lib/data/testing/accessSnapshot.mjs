import { creationResource } from "@sortsys/zerotrust/sortsys";

/** Build the new public transport envelope from existing cryptographic test
 * fixtures. This simulates transport only; native tests exercise transactions. */
export async function accessSnapshotFixture(client, input = {}, readPages) {
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
  const snapshot = "fixture-access-snapshot";
  const ids = [
    ...new Set([
      ...domains.map((domain) => domain.id),
      ...origins.map((origin) => origin.id),
    ]),
  ].sort();
  let offset = 0;
  if (input.after !== undefined) {
    if (input.snapshot !== snapshot || !ids.includes(input.after)) {
      return [null, new Error("Invalid fixture access continuation")];
    }
    offset = ids.indexOf(input.after) + 1;
  }
  const pageIds = ids.slice(offset, offset + 64);
  const page = {
    snapshot,
    origins: origins.filter((origin) => pageIds.includes(origin.id)),
    domains: domains.filter((domain) => pageIds.includes(domain.id)),
    after: offset + 64 < ids.length ? pageIds.at(-1) : null,
  };
  if (input.after !== undefined) return [page, null];
  let pages;
  if (input.pages) {
    const [result, error] = await readPages(input.pages);
    if (error) return [null, error];
    pages = result;
  }
  return [
    {
      subject: `user:${session.user.id}`,
      username: session.user.username,
      history,
      policy,
      ...page,
      unchanged: false,
      ...(pages ? { pages } : {}),
    },
    null,
  ];
}
