import { base64, unbase64 } from "./encoding";
import { passkeyPrfInput, PasskeyUnlock } from "./passkeyVault";

export type PasskeyDescriptor = {
  id: string;
  type: "public-key";
  transports?: readonly string[] | null | undefined;
};
export type PasskeyCreationOptions = Omit<
  PublicKeyCredentialCreationOptions,
  "challenge" | "user" | "rp" | "excludeCredentials" | "extensions"
> & {
  challenge: string;
  rp: PublicKeyCredentialRpEntity & { id: string };
  user: Omit<PublicKeyCredentialUserEntity, "id"> & { id: string };
  excludeCredentials?: readonly PasskeyDescriptor[];
};
export type PasskeyRequestOptions = Omit<
  PublicKeyCredentialRequestOptions,
  "challenge" | "rpId" | "allowCredentials" | "extensions"
> & {
  challenge: string;
  rpId: string;
  allowCredentials?: readonly PasskeyDescriptor[];
};
export type PasskeyRegistrationCredential = {
  id: string;
  rawId: string;
  type: "public-key";
  response: { clientDataJSON: string; attestationObject: string };
  transports?: string[];
};
export type PasskeyAssertionCredential = {
  id: string;
  rawId: string;
  type: "public-key";
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle: string | null;
  };
};
export type PasskeyCredentialResult<T> = {
  credential: T;
  unlock: PasskeyUnlock | null;
};
export type PasskeyErrorCode =
  | "unsupported"
  | "cancelled"
  | "invalid-response"
  | "prf-unavailable";

export class PasskeyOperationError extends Error {
  constructor(readonly code: PasskeyErrorCode) {
    super(`Passkey operation failed: ${code}`);
    this.name = "PasskeyOperationError";
  }
}

type PrfOutputs = AuthenticationExtensionsClientOutputs & {
  prf?: { enabled?: boolean; results?: { first?: BufferSource } };
};

export function isPasskeySupported(): boolean {
  return typeof window === "object" &&
    typeof PublicKeyCredential !== "undefined" &&
    !!navigator.credentials?.create && !!navigator.credentials?.get;
}

function prfExtensions(rpId: string): AuthenticationExtensionsClientInputs & {
  prf: { eval: { first: Uint8Array<ArrayBuffer> } };
} {
  return { prf: { eval: { first: passkeyPrfInput(rpId) } } };
}

/** Consume the PRF output locally. PublicKeyCredential.toJSON() must never be
 * used for transport: it can include the secret extension result. */
function localUnlock(credential: PublicKeyCredential, rpId: string) {
  const extensions: PrfOutputs =
    typeof credential.getClientExtensionResults === "function"
      ? credential.getClientExtensionResults()
      : {};
  const first = extensions.prf?.results?.first;
  const enabled = extensions.prf?.enabled === true;
  if (first === undefined) return { unlock: null, enabled };
  let secret: Uint8Array<ArrayBuffer>;
  if (first instanceof ArrayBuffer) {
    secret = new Uint8Array(first);
  } else if (ArrayBuffer.isView(first) && first.buffer instanceof ArrayBuffer) {
    secret = new Uint8Array(first.buffer, first.byteOffset, first.byteLength);
  } else {
    throw new PasskeyOperationError("invalid-response");
  }
  const unlock = PasskeyUnlock.consume(secret, {
    rpId,
    credentialId: base64(credential.rawId),
  });
  return { unlock, enabled };
}

export async function createPasskeyCredential(
  options: PasskeyCreationOptions,
  signal?: AbortSignal,
): Promise<PasskeyCredentialResult<PasskeyRegistrationCredential>> {
  requireSupport();
  const credential = await navigator.credentials.create({
    ...(signal ? { signal } : {}),
    publicKey: {
      ...options,
      challenge: unbase64(options.challenge, 1024),
      user: { ...options.user, id: unbase64(options.user.id, 1024) },
      excludeCredentials: (options.excludeCredentials ?? []).map(decodeDescriptor),
      extensions: prfExtensions(options.rp.id),
    },
  });
  if (!(credential instanceof PublicKeyCredential)) {
    throw new PasskeyOperationError("cancelled");
  }
  const response = credential.response;
  if (!(response instanceof AuthenticatorAttestationResponse)) {
    throw new PasskeyOperationError("invalid-response");
  }
  const result = localUnlock(credential, options.rp.id);
  let unlock = result.unlock;
  try {
    // Some authenticators evaluate PRF only during assertions. This extra
    // assertion targets the new credential and is never sent to the server.
    if (!unlock && result.enabled) {
      const assertion = await navigator.credentials.get({
        ...(signal ? { signal } : {}),
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rpId: options.rp.id,
          userVerification: "required",
          allowCredentials: [{ type: "public-key", id: credential.rawId }],
          extensions: prfExtensions(options.rp.id),
        },
      });
      if (
        !(assertion instanceof PublicKeyCredential) ||
        base64(assertion.rawId) !== base64(credential.rawId)
      ) throw new PasskeyOperationError("cancelled");
      unlock = localUnlock(assertion, options.rp.id).unlock;
      if (!unlock) throw new PasskeyOperationError("prf-unavailable");
    }
    const transports = typeof response.getTransports === "function"
      ? response.getTransports()
      : undefined;
    return {
      credential: {
        id: credential.id,
        rawId: base64(credential.rawId),
        type: "public-key",
        response: {
          clientDataJSON: base64(response.clientDataJSON),
          attestationObject: base64(response.attestationObject),
        },
        ...(transports ? { transports } : {}),
      },
      unlock,
    };
  } catch (error) {
    unlock?.dispose();
    throw error;
  }
}

export async function getPasskeyCredential(
  options: PasskeyRequestOptions,
  signal?: AbortSignal,
): Promise<PasskeyCredentialResult<PasskeyAssertionCredential>> {
  requireSupport();
  const credential = await navigator.credentials.get({
    ...(signal ? { signal } : {}),
    publicKey: {
      ...options,
      challenge: unbase64(options.challenge, 1024),
      allowCredentials: (options.allowCredentials ?? []).map(decodeDescriptor),
      extensions: prfExtensions(options.rpId),
    },
  });
  if (!(credential instanceof PublicKeyCredential)) {
    throw new PasskeyOperationError("cancelled");
  }
  const response = credential.response;
  if (!(response instanceof AuthenticatorAssertionResponse)) {
    throw new PasskeyOperationError("invalid-response");
  }
  const { unlock } = localUnlock(credential, options.rpId);
  try {
    return {
      credential: {
        id: credential.id,
        rawId: base64(credential.rawId),
        type: "public-key",
        response: {
          clientDataJSON: base64(response.clientDataJSON),
          authenticatorData: base64(response.authenticatorData),
          signature: base64(response.signature),
          userHandle: response.userHandle ? base64(response.userHandle) : null,
        },
      },
      unlock,
    };
  } catch (error) {
    unlock?.dispose();
    throw error;
  }
}

function requireSupport(): void {
  if (!isPasskeySupported()) throw new PasskeyOperationError("unsupported");
}

function decodeDescriptor(descriptor: PasskeyDescriptor): PublicKeyCredentialDescriptor {
  return {
    type: descriptor.type,
    id: unbase64(descriptor.id, 1024),
    ...(descriptor.transports
      ? { transports: descriptor.transports as AuthenticatorTransport[] }
      : {}),
  };
}
