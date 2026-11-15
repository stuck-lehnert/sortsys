import { RpcClientError } from "@sortsys/v2-client";

export type TechnicalErrorContext = {
  level?: "error" | "warning";
  source: string;
  path?: string | null;
  status?: number;
};

const SOURCES = new Set([
  "client.query",
  "client.queryDynamic",
  "client.streamQuery",
  "client.mutate",
  "client.mutateDynamic",
  "window.error",
  "window.unhandledrejection",
  "react-router.errorBoundary",
  "react.scopedErrorBoundary",
  "gaeb.autosave",
]);
const ROUTES = new Set([
  "admin",
  "settings",
  "projects",
  "offers",
  "gaeb",
  "products",
  "customers",
  "contacts",
  "users",
  "tools",
  "documents",
  "import",
  "llm",
  "dashboard",
]);

/** Error text, stacks, query strings and arbitrary metadata may contain decrypted
 * tenant content. Operator telemetry is restricted to technical constants. */
function isHttpStatus(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
  );
}

export function errorHttpStatus(error: unknown): number | undefined {
  if (!(error instanceof RpcClientError)) return undefined;
  const status = error.data?.httpCode;
  if (isHttpStatus(status)) return status;
  return undefined;
}

export function technicalErrorReport(
  input: TechnicalErrorContext,
  revision: string,
) {
  const segment = input.path?.split(/[/?#]/)[1];
  const metadata: { revision: string; status?: number } = {
    revision: "development",
  };
  if (/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(revision))
    metadata.revision = revision;
  if (isHttpStatus(input.status)) metadata.status = input.status;
  return {
    level:
      input.level === "warning" ? ("warning" as const) : ("error" as const),
    source: SOURCES.has(input.source) ? input.source : "client.error",
    message: "Client operation failed",
    stack: null,
    componentStack: null,
    path: segment && ROUTES.has(segment) ? `/${segment}` : "/",
    metadata,
  };
}
