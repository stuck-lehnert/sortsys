import { RpcClientError } from "@sortsys/v2-client";
import { uiText } from "./i18n";

export function loginErrorMessage(error: unknown): string {
  if (error instanceof RpcClientError && error.code === "TOO_MANY_REQUESTS") {
    return uiText("Zu viele Anmeldeversuche. Bitte später erneut versuchen.", "Too many login attempts. Please try again later.");
  }
  if (error instanceof RpcClientError && error.data?.httpCode === 503) {
    return uiText("Die Anmeldung ist vorübergehend nicht verfügbar. Bitte später erneut versuchen.", "Sign-in is temporarily unavailable. Please try again later.");
  }
  return error instanceof Error ? error.message : uiText("Anmeldung fehlgeschlagen", "Sign-in failed");
}
