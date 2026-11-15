import { expect, test } from "bun:test";
import { errorHttpStatus, technicalErrorReport } from "./errorTelemetry";
import { RpcClientError } from "@sortsys/v2-client";

test("operator telemetry never includes private error values, routes or arbitrary metadata", () => {
  const secret = "confidential-price-123.45-and-recovery-words";
  const input = {
    source: secret,
    level: "error",
    message: secret,
    stack: secret,
    componentStack: secret,
    path: `/gaeb/${secret}?name=${secret}#${secret}`,
    status: 409,
    metadata: { message: secret, status: 409, context: secret },
  };
  const result = technicalErrorReport(input, "public-build-revision");
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(result).toEqual({
    source: "client.error",
    level: "error",
    message: "Client operation failed",
    stack: null,
    componentStack: null,
    path: "/gaeb",
    metadata: { revision: "development", status: 409 },
  });
  expect(
    technicalErrorReport(
      {
        source: "gaeb.autosave",
        path: `/unknown-${secret}`,
        status: secret,
      },
      "build",
    ),
  ).toMatchObject({
    source: "gaeb.autosave",
    path: "/",
    metadata: { revision: "development" },
  });
  expect(
    technicalErrorReport({ source: "window.error" }, "a".repeat(40)).metadata
      .revision,
  ).toBe("a".repeat(40));
});

test("only bounded HTTP status codes are extracted from transport errors", () => {
  const failure = (status) =>
    new RpcClientError({
      code: -32603,
      message: "private error",
      data: { httpCode: status },
    });
  expect(errorHttpStatus(failure(503))).toBe(503);
  for (const status of [99, 600, 409.5, "409", NaN, Infinity])
    expect(errorHttpStatus(failure(status))).toBeUndefined();
  expect(errorHttpStatus(new Error("private error"))).toBeUndefined();
  expect(errorHttpStatus({ data: { httpCode: 503 } })).toBeUndefined();
});
