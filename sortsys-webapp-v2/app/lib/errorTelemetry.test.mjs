import { expect, test } from "bun:test";
import { technicalErrorReport } from "./errorTelemetry";

test("operator telemetry never includes private error values, routes or arbitrary metadata", () => {
  const secret = "confidential-price-123.45-and-recovery-words";
  const input = { source: secret, level: "error", message: secret, stack: secret, componentStack: secret, path: `/gaeb/${secret}?name=${secret}#${secret}`, metadata: { message: secret, status: 409, context: secret } };
  const result = technicalErrorReport(input, "public-build-revision");
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(result).toEqual({ source: "client.error", level: "error", message: "Client operation failed", stack: null, componentStack: null, path: "/gaeb", metadata: { revision: "public-build-revision", status: 409 } });
  expect(technicalErrorReport({ source: "gaeb.autosave", path: `/unknown-${secret}`, metadata: { status: secret } }, "build")).toMatchObject({ source: "gaeb.autosave", path: "/", metadata: { revision: "build" } });
});
