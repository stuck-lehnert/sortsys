import { createClient, type Client } from "@sortsys/v2-client";
import { browserApiEndpoint } from "./apiEndpoint";
import { BUILD_REVISION } from "./buildInfo";
import { lockCryptoSession, signIn } from "./crypto/session";
import { ramCache } from "./data/ramCache";
import {
  technicalErrorReport,
  type TechnicalErrorContext,
} from "./errorTelemetry";
import { llmActivity } from "./llmActivity";

export const API_ENDPOINT = browserApiEndpoint();

const transport = createClient(API_ENDPOINT, "webapp", {
  revision: BUILD_REVISION,
  cache: ramCache(),
  cacheable: (path) => !path.startsWith("zerotrust."),
});

// Public routes and the business facade share the same token and transport.
export const authClient: Client = {
  ...transport,
  login: (input) => signIn(transport, input),
  async logout() {
    try {
      await lockCryptoSession(true);
    } finally {
      await transport.logout();
    }
  },
};

transport.listenAuthState(() => {
  llmActivity.cancelAll();
  if (!transport.loggedIn()) void lockCryptoSession(true);
});

let reportingError = false;
let lastReportKey = "";
let lastReportAt = 0;

function browserPath() {
  if (typeof window !== "object") return null;
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

export async function reportClientError(input: TechnicalErrorContext) {
  if (reportingError || !transport.loggedIn()) return;

  const report = technicalErrorReport(
    { ...input, path: input.path ?? browserPath() },
    BUILD_REVISION,
  );
  const key = JSON.stringify(report);
  const now = Date.now();
  if (key === lastReportKey && now - lastReportAt < 5000) return;

  lastReportKey = key;
  lastReportAt = now;
  reportingError = true;

  try {
    await transport.mutate("errorReports.report", report);
  } catch {
    // Reporting must never break user flow.
  } finally {
    reportingError = false;
  }
}
