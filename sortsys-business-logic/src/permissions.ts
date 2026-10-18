/** Client visibility only; every protected operation still requires server authorization. */
export function canRole(
  roles: readonly string[],
  role: string,
  options: { manageImpliesView?: boolean } = {},
): boolean {
  if (roles.includes(":admin") || roles.includes(role)) return true;
  return (
    Boolean(options.manageImpliesView) &&
    role.startsWith("view:") &&
    roles.includes(`manage:${role.slice("view:".length)}`)
  );
}
