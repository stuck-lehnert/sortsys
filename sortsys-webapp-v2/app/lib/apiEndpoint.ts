/** The ordinary session and operator session must reach the same API, including
 * when an isolated development stack uses a different host port. */
export function resolveApiEndpoint(
  origin: string,
  development: boolean,
  port = "3000",
): string {
  if (!development) return "/api/v2";
  if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) {
    throw new Error("Invalid development API port");
  }
  const endpoint = new URL(origin);
  endpoint.port = port;
  return endpoint.origin;
}

export function browserApiEndpoint(): string {
  if (typeof window !== "object") return "";
  return resolveApiEndpoint(
    window.location.origin,
    import.meta.env.DEV,
    import.meta.env.VITE_API_PORT,
  );
}
