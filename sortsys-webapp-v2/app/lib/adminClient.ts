import { createClient } from "@sortsys/v2-client";

const HOST = (() => {
  if (typeof window !== "object") return "";

  const useDevHost = import.meta.env.DEV || window.location.hostname === "127.0.0.1";

  if (useDevHost) {
    const loc = window.location;
    return `${loc.protocol}//${loc.hostname}:3000`;
  }

  return "/api/v2";
})();

export const adminClient = createClient(HOST, "global-admin");

export function isBrowser() {
  return typeof window === "object" && typeof localStorage !== "undefined";
}

export async function restoreAdminSession() {
  if (!isBrowser()) return;

  await adminClient.restoreSession();
}

export async function loginGlobalAdmin(password: string) {
  const [data, err] = await adminClient.mutate("admin.login", {
    tenant: null,
    password,
  });

  if (err) {
    return [null, err] as const;
  }

  adminClient.setToken(data.token);
  return [data, null] as const;
}

export async function logoutGlobalAdmin() {
  await adminClient.clearCache();
  adminClient.setToken(null);
}
