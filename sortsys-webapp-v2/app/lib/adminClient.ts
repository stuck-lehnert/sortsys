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

const PRIMARY_TOKEN_STORAGE_KEY = "__sortsys-v2_token";
export const ADMIN_TOKEN_STORAGE_KEY = "__sortsys-v2_admin_token";

export const adminClient = createClient(HOST);

export function isBrowser() {
  return typeof window === "object" && typeof localStorage !== "undefined";
}

function readPrimaryToken() {
  if (!isBrowser()) return null;
  return localStorage.getItem(PRIMARY_TOKEN_STORAGE_KEY);
}

function restorePrimaryToken(value: string | null) {
  if (!isBrowser()) return;

  if (!value) {
    localStorage.removeItem(PRIMARY_TOKEN_STORAGE_KEY);
    return;
  }

  localStorage.setItem(PRIMARY_TOKEN_STORAGE_KEY, value);
}

function setAdminTokenIsolated(token: string | null) {
  const primaryToken = readPrimaryToken();
  adminClient.setToken(token);
  restorePrimaryToken(primaryToken);
}

function storeAdminToken(token: string | null) {
  if (!isBrowser()) return;

  if (!token) {
    localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
    return;
  }

  localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token);
}

export async function restoreAdminSession() {
  if (!isBrowser()) return;

  const token = localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY);
  setAdminTokenIsolated(token || null);

  if (token) {
    // user and global-admin sessions are intentionally separated.
    localStorage.removeItem(PRIMARY_TOKEN_STORAGE_KEY);
  }
}

export async function loginGlobalAdmin(password: string) {
  const [data, err] = await adminClient.mutate("admin.login", {
    tenant: null,
    password,
  });

  if (err) {
    return [null, err] as const;
  }

  setAdminTokenIsolated(data.token);
  storeAdminToken(data.token);

  if (isBrowser()) {
    // user and global-admin sessions are intentionally separated.
    localStorage.removeItem(PRIMARY_TOKEN_STORAGE_KEY);
  }

  return [data, null] as const;
}

export async function logoutGlobalAdmin() {
  await adminClient.clearCache();
  setAdminTokenIsolated(null);
  storeAdminToken(null);
}

if (isBrowser()) {
  adminClient.listenAuthState(() => {
    if (!adminClient.loggedIn()) {
      storeAdminToken(null);
    }
  });
}
