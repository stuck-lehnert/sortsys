import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { uiText } from "../i18n";

export type PasswordPolicy = Readonly<{ minimumLength?: number }>;

/** Enrollment normally requires ten characters. Local development clients can
 * explicitly choose six for documented demo accounts; no policy is sent to the API. */
export function validateNewPassword(
  password: string,
  policy: PasswordPolicy = {},
): void {
  const minimum = policy.minimumLength ?? 10;
  if (!Number.isInteger(minimum) || minimum < 6 || minimum > 2000) {
    throw new InvalidProtectedData();
  }
  if (password.length < minimum || password.length > 2000) {
    const message = uiText(
      "Das Passwort muss zwischen {minimum} und 2000 Zeichen lang sein.",
      "The password must contain between {minimum} and 2000 characters.",
    );
    throw new Error(message.replace("{minimum}", String(minimum)));
  }
}
