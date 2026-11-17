import { browserApiEndpoint } from "./apiEndpoint";
import { createClient, type Client } from "@sortsys/v2-client";
import { Observable } from "rxjs";
import { BUILD_REVISION } from "./buildInfo";
import { lockCryptoSession, signIn } from "./crypto/session";
import {
  errorHttpStatus,
  technicalErrorReport,
  type TechnicalErrorContext,
} from "./errorTelemetry";
import { createBusinessClient } from "./data/businessClient";
import { ramCache } from "./data/ramCache";
import { llmActivity } from "./llmActivity";

const HOST = browserApiEndpoint();
export const API_ENDPOINT = HOST;

const baseClient = createClient(HOST, "webapp", {
  revision: BUILD_REVISION,
  cache: ramCache(),
  cacheable: (path) => !path.startsWith("zerotrust."),
});
const businessClient = createBusinessClient(baseClient, {
  endpoint: HOST,
  realtime: true,
});

export const projectFiles = businessClient.files;
export const dataSession = businessClient.dataSession;
export const gaebDocuments = businessClient.documents;
export const toolResources = businessClient.toolResources;
export const organizationSettings = businessClient.organization;
export const organizationLogo = businessClient.logo;
export const protectedContent = businessClient.context;
export const templateAssets = businessClient.templates;
export const contentAccess = businessClient.access;
export const dashboardPreferences = businessClient.dashboard;
export const commonCostSettings = businessClient.commonCosts;

export function startAutomaticTimestampEvidence(
  signal: AbortSignal,
): () => void {
  let stop: (() => void) | undefined;
  void import("./crypto/timestampEvidence")
    .then((module) => {
      if (!signal.aborted)
        stop = module.startTimestampEvidence(baseClient, signal);
    })
    .catch(() => undefined);
  return () => stop?.();
}

let reportingError = false;
let lastReportKey = "";
let lastReportAt = 0;

function browserPath() {
  if (typeof window !== "object") return null;
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

export async function reportClientError(input: TechnicalErrorContext) {
  if (reportingError) return;
  if (!baseClient.loggedIn()) return;

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
    await baseClient.mutate("errorReports.report", report);
  } catch {
    // reporting must never break user flow.
  } finally {
    reportingError = false;
  }
}

export const client: Client = {
  ...businessClient,
  login: (input) => signIn(baseClient, input),
  logout: async () => {
    try {
      await lockCryptoSession(true);
    } finally {
      await baseClient.logout();
    }
  },
  query: (async (path: any, input: any, opts: any) => {
    const result = await businessClient.query(path, input, opts);
    const err = result[1];
    if (err) {
      void reportClientError({
        source: "client.query",
        status: errorHttpStatus(err),
      });
    }
    return result;
  }) as Client["query"],
  queryDynamic: async (path, input, opts) => {
    const result = await businessClient.queryDynamic(path, input, opts);
    const err = result[1];
    if (err) {
      void reportClientError({
        source: "client.queryDynamic",
        status: errorHttpStatus(err),
      });
    }
    return result;
  },
  streamQuery: ((path: any, input: any, opts: any) => {
    return new Observable((subscriber) => {
      const subscription = businessClient
        .streamQuery(path, input, opts)
        .subscribe({
          next(value) {
            const err = value[1];
            if (err) {
              void reportClientError({
                source: "client.streamQuery",
                status: errorHttpStatus(err),
              });
            }
            subscriber.next(value);
          },
          error(err) {
            void reportClientError({
              source: "client.streamQuery",
              status: errorHttpStatus(err),
            });
            subscriber.error(err);
          },
          complete() {
            subscriber.complete();
          },
        });

      return () => subscription.unsubscribe();
    });
  }) as Client["streamQuery"],
  mutate: (async (path: any, input: any, opts: any) => {
    const result = await businessClient.mutate(path, input, opts);
    const err = result[1];
    const expectedDocumentConflict =
      ["projects.files.xmlSave", "commercial.documents.save"].includes(path) &&
      err?.message.includes("changed in another editor");
    if (err && path !== "errorReports.report" && !expectedDocumentConflict) {
      void reportClientError({
        source: "client.mutate",
        status: errorHttpStatus(err),
      });
    }
    return result;
  }) as Client["mutate"],
  mutateDynamic: async (path, input, opts) => {
    const result = await businessClient.mutateDynamic(path, input, opts);
    const err = result[1];
    if (err && path !== "errorReports.report") {
      void reportClientError({
        source: "client.mutateDynamic",
        status: errorHttpStatus(err),
      });
    }
    return result;
  },
};

baseClient.listenAuthState(() => {
  llmActivity.cancelAll();
  if (!baseClient.loggedIn()) void lockCryptoSession(true);
});
