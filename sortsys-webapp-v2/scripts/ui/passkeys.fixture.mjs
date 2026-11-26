import superjson from "superjson";
import { createClient } from "@sortsys/v2-client";
import {
  base64,
  createAccountVault,
  createIdentity,
  publicIdentity,
} from "@sortsys/zerotrust";
import {
  acceptVault,
  acceptVaultWithKey,
  cryptoSignInPending,
  lockCryptoSession,
  unlockedAccount,
  withCryptoSignIn,
} from "../../app/lib/crypto/session";
import {
  registerPasskey,
  accountPasskeyHandle,
  signInWithPasskey,
} from "../../app/lib/crypto/passkeys";

// WebAuthn and all cryptography are real. Only the HTTP storage adapter is
// replaced here; the native replica tests exercise the actual server adapter.
const tenant = "browser-passkey";
const username = "owner";
const rpId = location.hostname;
const requests = [];
const secrets = [];
const consumedViews = [];
let creationResults = 0;
let assertionResults = 0;
let activeCreations = 0;
let activeAssertions = 0;
let accountVault;
let keyVault = null;
let registration = null;
let registrationProof = null;
let registrationReply = "normal";
let identityKeys;
let corruptWrapper = false;
let holdNextLogin = false;
let releaseLogin = null;

const nativeCreate = navigator.credentials.create.bind(navigator.credentials);
navigator.credentials.create = async (options) => {
  activeCreations++;
  try {
    return await nativeCreate(options);
  } finally {
    activeCreations--;
  }
};
const nativeGet = navigator.credentials.get.bind(navigator.credentials);
navigator.credentials.get = async (options) => {
  activeAssertions++;
  try {
    return await nativeGet(options);
  } finally {
    activeAssertions--;
  }
};

const originalResults = PublicKeyCredential.prototype.getClientExtensionResults;
PublicKeyCredential.prototype.getClientExtensionResults = function () {
  const extensions = originalResults.call(this);
  if (this.response instanceof AuthenticatorAttestationResponse) {
    creationResults++;
    // Model authenticators that report PRF support during creation but return
    // its output only on assertion. The following assertion still uses the
    // browser's real PRF result; no synthetic key material is substituted.
    if (window.passkeyAssertionOnly && extensions.prf?.results?.first) {
      new Uint8Array(extensions.prf.results.first).fill(0);
      delete extensions.prf.results;
    }
  } else {
    assertionResults++;
  }
  const secret = extensions.prf?.results?.first;
  if (secret) {
    const view = new Uint8Array(secret);
    secrets.push(view.slice());
    consumedViews.push(view);
  }
  return extensions;
};
PublicKeyCredential.prototype.toJSON = function () {
  throw new Error("Native credential serialization could disclose PRF output");
};

function challenge() {
  return base64(crypto.getRandomValues(new Uint8Array(32)));
}

async function registrationOptions() {
  return {
    challengeToken: "synthetic-registration-challenge",
    options: {
      challenge: challenge(),
      rp: { id: rpId, name: "Sortsys browser test" },
      user: {
        id: await accountPasskeyHandle(tenant, "user:1"),
        name: `${username}@${tenant}`,
        displayName: "Synthetic owner",
      },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      timeout: 30000,
      attestation: "none",
      authenticatorSelection: {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "required",
      },
      excludeCredentials: [],
    },
  };
}

async function responseFor(path, input) {
  if (path === "auth.passkeys.list")
    return registration
      ? [
          {
            id: "1",
            label: "Browser authenticator",
            credentialId: registration.rawId,
            identityProof: registrationProof,
            createdAt: new Date(),
            lastUsedAt: null,
            opensData: keyVault !== null,
          },
        ]
      : [];
  if (path === "auth.passkeys.registerOptions") return registrationOptions();
  if (path === "auth.passkeys.register") {
    if (registrationReply === "unpublished") return { success: true };
    registration = structuredClone(input.credential);
    registrationProof = input.identityProof;
    keyVault = input.keyVault ?? null;
    return { success: true };
  }
  if (path === "auth.passkeys.loginOptions") {
    return {
      challengeToken: "synthetic-login-challenge",
      options: {
        challenge: challenge(),
        rpId,
        allowCredentials: [],
        timeout: 30000,
        userVerification: "required",
      },
    };
  }
  if (path === "auth.passkeys.login") {
    if (holdNextLogin) {
      holdNextLogin = false;
      await new Promise((resolve) => {
        releaseLogin = resolve;
      });
    }
    const packet = keyVault ? structuredClone(keyVault) : null;
    if (packet && corruptWrapper) packet.wrappedKey = challenge();
    return {
      token: "synthetic-passkey-session",
      tenant,
      username,
      subject: accountVault.subject,
      accountVault,
      keyVault: packet,
    };
  }
  throw new Error(`Unexpected request: ${path}`);
}

const client = createClient(location.origin, "passkey-browser-test", {
  fetch: async (input, options) => {
    const url = new URL(String(input));
    const paths = url.pathname.slice(1).split(",");
    const inputs = JSON.parse(options?.body ?? url.searchParams.get("input"));
    const outputs = [];
    for (const [index, path] of paths.entries()) {
      const value = superjson.deserialize(inputs[index]);
      requests.push({ path, body: JSON.stringify(value) });
      const data = await responseFor(path, value);
      if (path === "auth.passkeys.register" && registrationReply === "lost") {
        throw new TypeError("Synthetic response lost after publication");
      }
      outputs.push({ result: { data: superjson.serialize(data) } });
    }
    return new Response(JSON.stringify(outputs));
  },
});

window.passkeyFixture = {
  async initialize() {
    await lockCryptoSession(true);
    const identity = await createIdentity();
    identityKeys = await publicIdentity(identity);
    const exportKey = base64(crypto.getRandomValues(new Uint8Array(64)));
    accountVault = await createAccountVault(
      exportKey,
      tenant,
      "user:1",
      identity,
    );
    client.setToken("synthetic-owner-session");
    await acceptVault(exportKey, accountVault, username, false);
  },
  register() {
    return registerPasskey(client, "Browser authenticator");
  },
  registrationReply(mode) {
    registrationReply = mode;
  },
  async coldDevice() {
    await lockCryptoSession(true);
    client.setToken(null);
  },
  async rememberDevice() {
    const current = unlockedAccount();
    await acceptVaultWithKey(current.dataKey, current.vault, current.username);
  },
  async failAfterUnlock() {
    const current = unlockedAccount();
    try {
      await withCryptoSignIn(client, async () => {
        await acceptVaultWithKey(
          current.dataKey,
          current.vault,
          current.username,
          false,
        );
        throw new Error("Synthetic failure after local decryption");
      });
    } catch {
      return;
    }
    throw new Error("A failed sign-in must reject");
  },
  async lock() {
    await lockCryptoSession();
    client.setToken(null);
  },
  async signIn() {
    try {
      await signInWithPasskey(client);
      return { success: true };
    } catch (error) {
      return { success: false, name: error.name };
    }
  },
  corruptWrapper() {
    corruptWrapper = true;
  },
  holdLogin() {
    holdNextLogin = true;
  },
  releaseLogin() {
    releaseLogin?.();
    releaseLogin = null;
  },
  async state() {
    const account = unlockedAccount();
    const openedKeys = account ? await publicIdentity(account.identity) : null;
    const bodies = JSON.stringify(requests);
    return {
      authenticated: client.loggedIn(),
      unlocked: account !== null,
      identityMatches:
        openedKeys !== null &&
        JSON.stringify(openedKeys) === JSON.stringify(identityKeys),
      pending: cryptoSignInPending(),
      registrationStored: registration !== null,
      encryptedKeyStored: keyVault !== null,
      secretCount: secrets.length,
      creationResults,
      assertionResults,
      activeCreations,
      activeAssertions,
      secretsLeaked: secrets.some(
        (secret) =>
          bodies.includes(base64(secret)) ||
          bodies.includes(JSON.stringify([...secret])),
      ),
      secretViewsWiped: consumedViews.every((view) =>
        view.every((byte) => byte === 0),
      ),
      extensionOutputUploaded: bodies.includes("clientExtensionResults"),
      loginHeld: releaseLogin !== null,
      paths: requests.map((request) => request.path),
    };
  },
};
