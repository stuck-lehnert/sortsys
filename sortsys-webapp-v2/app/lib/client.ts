import type { Client } from "@sortsys/v2-client";
import { Observable } from "rxjs";
import { API_ENDPOINT, authClient, reportClientError } from "./authClient";
import { createBusinessClient } from "./data/businessClient";
import { errorHttpStatus } from "./errorTelemetry";

export { API_ENDPOINT, reportClientError } from "./authClient";

const businessClient = createBusinessClient(authClient, {
  endpoint: API_ENDPOINT,
  realtime: true,
});

export const projectFiles = businessClient.files;
export const assistant = businessClient.assistant;
export const dataSession = businessClient.dataSession;
export const gaebDocuments = businessClient.documents;
export const toolResources = businessClient.toolResources;
export const streamDirectorySearch = businessClient.streamDirectorySearch;
export const streamPersonnelName = businessClient.streamPersonnelName;
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
        stop = module.startTimestampEvidence(authClient, signal);
    })
    .catch(() => undefined);
  return () => stop?.();
}

export const client: Client = {
  ...businessClient,
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
