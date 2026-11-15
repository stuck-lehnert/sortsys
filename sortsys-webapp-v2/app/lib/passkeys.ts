import type { MutateInput, MutateOutput } from "@sortsys/v2-client";
import {
  createPasskeyCredential as createCredential,
  getPasskeyCredential as getCredential,
  PasskeyOperationError,
  type PasskeyCredentialResult,
} from "@sortsys/zerotrust";
import { uiText } from "~/lib/i18n";

export { isPasskeySupported } from "@sortsys/zerotrust";

export function createPasskeyCredential(
  options: MutateOutput<"auth.passkeys.registerOptions">["options"],
  signal?: AbortSignal,
): Promise<
  PasskeyCredentialResult<MutateInput<"auth.passkeys.register">["credential"]>
> {
  return localized(() => createCredential(options, signal));
}

export function getPasskeyCredential(
  options: MutateOutput<"auth.passkeys.loginOptions">["options"],
  signal?: AbortSignal,
): Promise<
  PasskeyCredentialResult<MutateInput<"auth.passkeys.login">["credential"]>
> {
  return localized(() => getCredential(options, signal));
}

async function localized<T>(perform: () => Promise<T>): Promise<T> {
  try {
    return await perform();
  } catch (error) {
    if (!(error instanceof PasskeyOperationError)) throw error;
    switch (error.code) {
      case "unsupported":
        throw new Error(
          uiText(
            "Passkeys werden von diesem Browser nicht unterstützt.",
            "Passkeys are not supported by this browser.",
          ),
        );
      case "cancelled":
        throw new Error(
          uiText(
            "Passkey-Vorgang wurde abgebrochen.",
            "Passkey operation was cancelled.",
          ),
        );
      case "invalid-response":
        throw new Error(
          uiText("Ungültige Passkey-Antwort.", "Invalid passkey response."),
        );
      case "prf-unavailable":
        throw new Error(
          uiText(
            "Der Passkey konnte nicht eingerichtet werden. Bitte erneut versuchen.",
            "The passkey could not be configured. Please try again.",
          ),
        );
    }
  }
}
