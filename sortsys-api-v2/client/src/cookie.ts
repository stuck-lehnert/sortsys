
interface CookieOptions {
  days?: number | null;   // null = session cookie
  path?: string;
  domain?: string;
  sameSite?: "Lax" | "Strict" | "None";
  secure?: boolean;
}


export function setCookie(
  name: string,
  value: string,
  options: CookieOptions = {}
): void {
  const {
    days = 7,
    path = "/",
    domain,
    sameSite = "Lax",
    secure = true
  } = options;

  let cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;

  if (days !== null) {
    const expires = new Date(Date.now() + days * 864e5).toUTCString();
    cookie += `; Expires=${expires}`;
  }

  cookie += `; Path=${path}`;

  if (domain) {
    cookie += `; Domain=${domain}`;
  }

  cookie += `; SameSite=${sameSite}`;

  if (secure) {
    cookie += `; Secure`;
  }

  document.cookie = cookie;
}


export function deleteCookie(
  name: string,
  options: Pick<CookieOptions, "path" | "domain"> = {}
): void {
  const { path = "/", domain } = options;

  let cookie = `${encodeURIComponent(name)}=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=${path}`;

  if (domain) {
    cookie += `; Domain=${domain}`;
  }

  document.cookie = cookie;
}
