import { expect, test } from "bun:test";
import { RpcClientError } from "@sortsys/v2-client";
import { loginErrorMessage } from "./loginError.ts";

test("login throttling and temporary failure show actionable localized messages", () => {
  const throttled = new RpcClientError({ message: "provider detail", code: -32029, data: { code: "TOO_MANY_REQUESTS", httpCode: 429 } });
  expect(loginErrorMessage(throttled)).toBe("Zu viele Anmeldeversuche. Bitte später erneut versuchen.");
  const unavailable = new RpcClientError({ message: "database detail", code: -32603, data: { code: "INTERNAL_SERVER_ERROR", httpCode: 503 } });
  expect(loginErrorMessage(unavailable)).toBe("Die Anmeldung ist vorübergehend nicht verfügbar. Bitte später erneut versuchen.");
  expect(loginErrorMessage(new Error("Unrelated validation error"))).toBe("Unrelated validation error");
});
