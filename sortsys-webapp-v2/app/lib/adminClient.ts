import { browserApiEndpoint } from "./apiEndpoint";
import { createClient } from "@sortsys/v2-client";
import { BUILD_REVISION } from "./buildInfo";

const HOST = browserApiEndpoint();

export const adminClient = createClient(HOST, "global-admin", {
  revision: BUILD_REVISION,
});

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
