function origin(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  const parsed = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password
    || parsed.protocol !== "https:" && !(loopback && parsed.protocol === "http:")
    || !/^(?:[a-z0-9.-]+|\[[0-9a-f:]+\])(?::[0-9]+)?$/i.test(parsed.host)) throw new Error(`${name} must be an HTTPS origin`);
  return parsed;
}
module.exports = () => {
  const main = origin("OFFICE_PUBLIC_ORIGIN"), sandbox = origin("OFFICE_SANDBOX_ORIGIN"), app = origin("SORTSYS_PUBLIC_ORIGIN");
  if (new Set([main.origin, sandbox.origin, app.origin]).size !== 3) throw new Error("The application and both Office origins must be different");
  return { main, sandbox, app };
};
