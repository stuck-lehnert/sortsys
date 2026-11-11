const SOURCES = new Set([
  "client.query", "client.queryDynamic", "client.streamQuery", "client.mutate", "client.mutateDynamic",
  "window.error", "window.unhandledrejection", "react-router.errorBoundary", "react.scopedErrorBoundary", "gaeb.autosave",
]);
const ROUTES = new Set(["admin", "settings", "projects", "offers", "gaeb", "products", "customers", "contacts", "users", "tools", "documents", "import", "llm", "dashboard"]);

/** Error text, stacks, query strings and arbitrary metadata may contain decrypted
 * tenant content. Operator telemetry is restricted to technical constants. */
export function technicalErrorReport(input: {
  level?: "error" | "warning"; source: string; path?: string | null;
  metadata?: Record<string, unknown> | null;
}, revision: string) {
  const segment = input.path?.split(/[/?#]/)[1];
  const status = input.metadata?.status;
  return {
    level: input.level === "warning" ? "warning" as const : "error" as const,
    source: SOURCES.has(input.source) ? input.source : "client.error",
    message: "Client operation failed",
    stack: null,
    componentStack: null,
    path: segment && ROUTES.has(segment) ? `/${segment}` : "/",
    metadata: {
      revision,
      ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
    },
  };
}
