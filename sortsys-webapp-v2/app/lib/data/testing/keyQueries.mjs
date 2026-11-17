/** Explicit recipient-key reads use both endpoints. Permission tests must
 * count the combined response as well as the individual envelope lookup. */
export function isKeyEnvelopeQuery(path) {
  return path === "zerotrust.keys.get" || path === "zerotrust.keys.history";
}
