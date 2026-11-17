import superjson from "superjson";
import { createClient } from "@sortsys/v2-client";
import {
  base64,
  bytes,
  digest,
  frame,
  importSigningKey,
  passkeyRegistrationFrame,
  passkeyVaultDigest,
  registrationCredentialFrame,
  sign,
  unbase64,
  verify,
} from "@sortsys/zerotrust";
import {
  changeOwnPassword,
  lockCryptoSession,
  signIn,
  unlockedAccount,
} from "../../app/lib/crypto/session";
import {
  registerPasskey,
  removePasskey,
  signInWithPasskey,
} from "../../app/lib/crypto/passkeys";
import { ramCache } from "../../app/lib/data/ramCache";

const originalFetch = window.fetch;
const calls = [];
const authorizations = [null, null];
const prfSecrets = [];
const originalExtensions =
  PublicKeyCredential.prototype.getClientExtensionResults;
PublicKeyCredential.prototype.getClientExtensionResults = function () {
  const output = originalExtensions.call(this);
  const secret = output.prf?.results?.first;
  if (secret) {
    const view = ArrayBuffer.isView(secret)
      ? new Uint8Array(secret.buffer, secret.byteOffset, secret.byteLength)
      : new Uint8Array(secret);
    prfSecrets.push(view.slice());
  }
  return output;
};
window.fetch = new Proxy(originalFetch, {
  apply(target, receiver, args) {
    const url = new URL(
      args[0] instanceof Request ? args[0].url : String(args[0]),
      location.href,
    );
    const side = url.pathname.startsWith("/api-two/") ? 1 : 0;
    const headers = new Headers(
      args[1]?.headers ??
        (args[0] instanceof Request ? args[0].headers : undefined),
    );
    if (headers.get("authorization"))
      authorizations[side] = headers.get("authorization");
    const body = typeof args[1]?.body === "string" ? args[1].body : null;
    calls.push({
      path: url.pathname,
      input: body ?? url.searchParams.get("input"),
      authorization: headers.get("authorization"),
    });
    return Reflect.apply(target, receiver, args);
  },
});
const clients = ["one", "two"].map((part) =>
  createClient(`${location.origin}/api-${part}/`, `native-passkey-${part}`, {
    cache: ramCache(),
  }),
);
let selected = 0;
let devices = [];
let sourceRegistration = null;
let lastLogin = null;
let busy = false;
let error = "";
const signers = new Map();
const root = document.getElementById("root");
root.innerHTML = `<h1>Passkey-Anmeldung</h1><form id="login"><label>Organisation <input name="tenant" value="passkey-tenant-a" /></label><label>Anmeldename <input name="username" value="builder" /></label><label>Passwort <input name="password" type="password" /></label><button>Anmelden</button></form><label>Gerätename <input id="label" value="Browser authenticator" /></label><button id="register">Passkey einrichten</button><button id="cold">Lokalen Zugang schließen</button><button id="passkey">Mit Passkey anmelden</button><ul aria-label="Passkeys"></ul><p role="alert"></p><output aria-label="Anmeldestatus"></output>`;
async function required(promise) {
  const [value, failure] = await promise;
  if (failure) throw failure;
  if (!value) throw new Error("Fehlende Antwort");
  return value;
}
async function refresh() {
  devices = await required(
    clients[selected].query("auth.passkeys.list", undefined, {
      strategy: "network-only",
    }),
  );
}
function render() {
  const account = unlockedAccount();
  root.querySelector("output").textContent = JSON.stringify({
    busy,
    error,
    unlocked: Boolean(account),
    authenticated: clients[selected].loggedIn(),
    username: account?.username ?? null,
    tenant: account?.tenant ?? null,
    subject: account?.vault.subject ?? null,
    identityMatches: Boolean(
      account && signers.get(account.tenant) === account.vault.signingKey,
    ),
    devices: devices.map(({ id, label, opensData }) => ({
      id,
      label,
      opensData,
    })),
  });
  root.querySelector('[role="alert"]').textContent = error;
  const list = root.querySelector("ul");
  list.replaceChildren(
    ...devices.map((device) => {
      const item = document.createElement("li");
      item.textContent = `${device.label} – ${device.opensData ? "Entschlüsselung verfügbar" : "Nur Anmeldung"}`;
      return item;
    }),
  );
  for (const button of root.querySelectorAll("button")) button.disabled = busy;
}
async function run(action) {
  busy = true;
  error = "";
  render();
  try {
    await action();
  } catch (failure) {
    error =
      failure instanceof Error ? failure.message : "Aktion fehlgeschlagen";
  } finally {
    busy = false;
    render();
  }
}
async function password(tenant, username, value) {
  selected = 0;
  devices = [];
  await signIn(clients[selected], { tenant, username, password: value });
  const account = unlockedAccount();
  if (!account) throw new Error("Kontotresor nicht geöffnet");
  if (!signers.has(tenant)) signers.set(tenant, account.vault.signingKey);
  await refresh();
  render();
}
async function enroll(label) {
  await registerPasskey(clients[selected], label);
  sourceRegistration = structuredClone(
    calls.findLast((call) => call.path.endsWith("/auth.passkeys.register")),
  );
  await refresh();
  render();
}
async function cold() {
  await lockCryptoSession(true);
  for (const client of clients) client.setToken(null);
  devices = [];
  render();
}
async function passkey() {
  selected = 1;
  await signInWithPasskey(clients[selected]);
  lastLogin = structuredClone(
    calls.findLast((call) => call.path.endsWith("/auth.passkeys.login")),
  );
  const account = unlockedAccount();
  if (account) {
    const message = frame("sortsys/native-passkey-test/v1", [
      account.tenant,
      account.vault.subject,
    ]);
    await verify(
      await importSigningKey(signers.get(account.tenant)),
      await sign(account.identity.signingKey.privateKey, message),
      message,
    );
  }
  await refresh();
  render();
}
async function raw(
  path,
  input,
  side = 0,
  authorization = authorizations[side],
) {
  const response = await fetch(
    `/api-${side === 0 ? "one" : "two"}/${path}?batch=1`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify({ 0: superjson.serialize(input) }),
    },
  );
  const [payload] = await response.json();
  if (payload.error)
    return { ok: false, error: superjson.deserialize(payload.error) };
  return { ok: true, value: superjson.deserialize(payload.result.data) };
}
async function rejectedRegistration(mode) {
  const stored = superjson.deserialize(
    JSON.parse(sourceRegistration.input)["0"],
  );
  if (mode === "replay")
    return raw(
      "auth.passkeys.register",
      stored,
      1,
      sourceRegistration.authorization,
    );
  const options = await required(
    clients[selected].mutate("auth.passkeys.registerOptions", undefined),
  );
  const credential = structuredClone(stored.credential);
  const data = JSON.parse(
    new TextDecoder().decode(
      unbase64(credential.response.clientDataJSON, 8192),
    ),
  );
  data.challenge = options.options.challenge;
  data.origin =
    mode === "origin" ? "https://invalid.example.test" : location.origin;
  credential.response.clientDataJSON = base64(bytes(JSON.stringify(data)));
  const keyVault =
    mode === "wrapper"
      ? {
          ...stored.keyVault,
          wrappedKey: base64(crypto.getRandomValues(new Uint8Array(40))),
        }
      : undefined;
  const account = unlockedAccount();
  const input = {
    challengeToken: options.challengeToken,
    label: "Copied credential",
    credential,
    ...(keyVault ? { keyVault } : {}),
  };
  input.identityProof = await sign(
    account.identity.signingKey.privateKey,
    passkeyRegistrationFrame({
      tenant: account.tenant,
      subject: account.vault.subject,
      userHandle: options.options.user.id,
      exchangeHash: await digest(bytes(options.challengeToken)),
      credentialHash: await digest(registrationCredentialFrame(credential)),
      keyVaultHash: await passkeyVaultDigest(keyVault),
      label: input.label,
    }),
  );
  if (mode === "unsigned") input.identityProof = base64(new Uint8Array(64));
  return raw("auth.passkeys.register", input, selected);
}
root.querySelector("form").addEventListener("submit", (event) => {
  event.preventDefault();
  const values = new FormData(event.target);
  void run(() =>
    password(
      values.get("tenant"),
      values.get("username"),
      values.get("password"),
    ),
  );
});
root.querySelector("#register").onclick = () =>
  void run(() => enroll(root.querySelector("#label").value));
root.querySelector("#cold").onclick = () => void run(cold);
root.querySelector("#passkey").onclick = () => void run(passkey);
window.nativePasskey = {
  password,
  enroll,
  cold,
  passkey,
  rejectedRegistration,
  raw,
  async registrationOptions() {
    return required(
      clients[selected].mutate("auth.passkeys.registerOptions", undefined),
    );
  },
  async registerPublicPacket({ options, credential }) {
    const account = unlockedAccount();
    const label = "Zero counter";
    const identityProof = await sign(
      account.identity.signingKey.privateKey,
      passkeyRegistrationFrame({
        tenant: account.tenant,
        subject: account.vault.subject,
        userHandle: options.options.user.id,
        exchangeHash: await digest(bytes(options.challengeToken)),
        credentialHash: await digest(registrationCredentialFrame(credential)),
        keyVaultHash: "",
        label,
      }),
    );
    await required(
      clients[selected].mutate("auth.passkeys.register", {
        challengeToken: options.challengeToken,
        label,
        identityProof,
        credential,
      }),
    );
    await refresh();
    render();
    return devices.find((device) => device.label === label);
  },
  async replayLogin() {
    return raw(
      "auth.passkeys.login",
      superjson.deserialize(JSON.parse(lastLogin.input)["0"]),
      0,
      null,
    );
  },
  async changePassword() {
    await changeOwnPassword(
      clients[selected],
      "Passkey-preserved-password-2026!",
    );
    render();
  },
  async remove(id) {
    await removePasskey(clients[selected], id);
    await refresh();
    render();
  },
  async list() {
    await refresh();
    return devices;
  },
  state() {
    return JSON.parse(root.querySelector("output").textContent);
  },
  privacy() {
    const wire = calls.map((call) => call.input ?? "").join("\n");
    const encodedBuffers = [];
    const collect = (value) => {
      if (typeof value === "string" && /^[A-Za-z0-9_-]{43,}$/.test(value)) {
        try {
          encodedBuffers.push(unbase64(value, 100_000));
        } catch {
          /* Not a canonical binary field. */
        }
      } else if (value && typeof value === "object") {
        for (const entry of Object.values(value)) collect(entry);
      }
    };
    for (const call of calls) {
      if (call.input) collect(JSON.parse(call.input));
    }
    const contains = (buffer, secret) => {
      for (let start = 0; start <= buffer.length - secret.length; start++) {
        if (secret.every((byte, offset) => buffer[start + offset] === byte))
          return true;
      }
      return false;
    };
    return {
      requests: calls.length,
      prfResults: prfSecrets.length,
      secretLeaked: prfSecrets.some(
        (secret) =>
          wire.includes(base64(secret)) ||
          wire.includes(JSON.stringify([...secret])) ||
          encodedBuffers.some((buffer) => contains(buffer, secret)),
      ),
      passwordLeaked: [
        "Only-owner-knows-this-password-2026!",
        "Passkey-preserved-password-2026!",
      ].some((value) => wire.includes(value)),
      extensionOutputUploaded: wire.includes("clientExtensionResults"),
    };
  },
};
render();
