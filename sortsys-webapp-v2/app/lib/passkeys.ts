import { uiText } from "~/lib/i18n";
type EncodedCredentialDescriptor = {
  id: string;
  type: 'public-key';
  transports?: string[];
};

type EncodedCreationOptions = {
  challenge: string;
  rp: PublicKeyCredentialRpEntity;
  user: {
    id: string;
    name: string;
    displayName: string;
  };
  pubKeyCredParams: PublicKeyCredentialParameters[];
  timeout: number;
  attestation: AttestationConveyancePreference;
  authenticatorSelection: AuthenticatorSelectionCriteria;
  excludeCredentials: EncodedCredentialDescriptor[];
};

type EncodedRequestOptions = {
  challenge: string;
  rpId: string;
  allowCredentials: EncodedCredentialDescriptor[];
  timeout: number;
  userVerification: UserVerificationRequirement;
};

export function isPasskeySupported() {
  return typeof window === 'object'
    && typeof PublicKeyCredential !== 'undefined'
    && !!navigator.credentials?.create
    && !!navigator.credentials?.get;
}

export async function createPasskeyCredential(options: EncodedCreationOptions) {
  if (!isPasskeySupported()) throw new Error(uiText("Passkeys werden von diesem Browser nicht unterstützt."));

  const credential = await navigator.credentials.create({
    publicKey: {
      ...options,
      challenge: base64UrlToArrayBuffer(options.challenge),
      user: {
        ...options.user,
        id: base64UrlToArrayBuffer(options.user.id),
      },
      excludeCredentials: options.excludeCredentials.map(decodeDescriptor),
    },
  });

  if (!(credential instanceof PublicKeyCredential)) throw new Error(uiText("Passkey-Erstellung wurde abgebrochen."));
  const response = credential.response;
  if (!(response instanceof AuthenticatorAttestationResponse)) throw new Error(uiText("Ungültige Passkey-Antwort."));

  return {
    id: credential.id,
    rawId: arrayBufferToBase64Url(credential.rawId),
    type: credential.type as 'public-key',
    response: {
      clientDataJSON: arrayBufferToBase64Url(response.clientDataJSON),
      attestationObject: arrayBufferToBase64Url(response.attestationObject),
    },
    transports: typeof response.getTransports === 'function' ? response.getTransports() : undefined,
  };
}

export async function getPasskeyCredential(options: EncodedRequestOptions) {
  if (!isPasskeySupported()) throw new Error(uiText("Passkeys werden von diesem Browser nicht unterstützt."));

  const credential = await navigator.credentials.get({
    publicKey: {
      ...options,
      challenge: base64UrlToArrayBuffer(options.challenge),
      allowCredentials: options.allowCredentials.map(decodeDescriptor),
    },
  });

  if (!(credential instanceof PublicKeyCredential)) throw new Error(uiText("Passkey-Anmeldung wurde abgebrochen."));
  const response = credential.response;
  if (!(response instanceof AuthenticatorAssertionResponse)) throw new Error(uiText("Ungültige Passkey-Antwort."));

  return {
    id: credential.id,
    rawId: arrayBufferToBase64Url(credential.rawId),
    type: credential.type as 'public-key',
    response: {
      clientDataJSON: arrayBufferToBase64Url(response.clientDataJSON),
      authenticatorData: arrayBufferToBase64Url(response.authenticatorData),
      signature: arrayBufferToBase64Url(response.signature),
      userHandle: response.userHandle ? arrayBufferToBase64Url(response.userHandle) : null,
    },
  };
}

function decodeDescriptor(descriptor: EncodedCredentialDescriptor): PublicKeyCredentialDescriptor {
  return {
    ...descriptor,
    id: base64UrlToArrayBuffer(descriptor.id),
    transports: descriptor.transports as AuthenticatorTransport[] | undefined,
  };
}

function base64UrlToArrayBuffer(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = window.atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function arrayBufferToBase64Url(value: ArrayBuffer) {
  const bytes = new Uint8Array(value);
  let binary = '';
  bytes.forEach(byte => {
    binary += String.fromCharCode(byte);
  });
  return window.btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}
