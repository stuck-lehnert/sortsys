import { createClient, type Client } from "@sortsys/v2-client";
import { Observable } from "rxjs";
import { uiText } from "./i18n";

const HOST = (() => {
  if (typeof window !== 'object') return '';

  const useDevHost = import.meta.env.DEV || window.location.hostname === '127.0.0.1';
  
  if (useDevHost) {
    const loc = window.location;
    return `${loc.protocol}//${loc.hostname}:3000`;
  }

  return '/api/v2';
})();

const baseClient = createClient(HOST, "webapp");

type ClientErrorReportInput = {
  level?: 'error' | 'warning';
  source: string;
  message: string;
  stack?: string | null;
  path?: string | null;
  componentStack?: string | null;
  metadata?: Record<string, unknown> | null;
};

let reportingError = false;
let lastReportKey = '';
let lastReportAt = 0;

function browserPath() {
  if (typeof window !== 'object') return null;
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function reportKey(input: ClientErrorReportInput) {
  return [input.source, input.message, input.path ?? browserPath() ?? ''].join('\n');
}

export async function reportClientError(input: ClientErrorReportInput) {
  if (reportingError) return;
  if (!baseClient.loggedIn()) return;

  const key = reportKey(input);
  const now = Date.now();
  if (key === lastReportKey && now - lastReportAt < 5000) return;
  lastReportKey = key;
  lastReportAt = now;

  reportingError = true;
  try {
    await baseClient.mutate('errorReports.report', {
      level: input.level ?? 'error',
      source: input.source,
      message: input.message.slice(0, 4000),
      stack: input.stack ?? null,
      path: input.path ?? browserPath(),
      componentStack: input.componentStack ?? null,
      metadata: input.metadata ?? null,
    });
  } catch {
    // reporting must never break user flow.
  } finally {
    reportingError = false;
  }
}

function errorMessage(err: unknown) {
  if (err instanceof Error) return err.message;
  return `${err || uiText('Unbekannter Fehler')}`;
}

function errorStack(err: unknown) {
  return err instanceof Error ? err.stack ?? null : null;
}

export const client: Client = {
  ...baseClient,
  query: (async (path: any, input: any, opts: any) => {
    const result = await baseClient.query(path, input, opts);
    const err = result[1];
    if (err) {
      void reportClientError({
        source: 'client.query',
        message: errorMessage(err),
        stack: errorStack(err),
        metadata: { trpcPath: path },
      });
    }
    return result;
  }) as Client['query'],
  queryDynamic: async (path, input, opts) => {
    const result = await baseClient.queryDynamic(path, input, opts);
    const err = result[1];
    if (err) {
      void reportClientError({
        source: 'client.queryDynamic',
        message: errorMessage(err),
        stack: errorStack(err),
        metadata: { trpcPath: path },
      });
    }
    return result;
  },
  streamQuery: ((path: any, input: any, opts: any) => {
    return new Observable((subscriber) => {
      const subscription = baseClient.streamQuery(path, input, opts).subscribe({
        next(value) {
          const err = value[1];
          if (err) {
            void reportClientError({
              source: 'client.streamQuery',
              message: errorMessage(err),
              stack: errorStack(err),
              metadata: { trpcPath: path },
            });
          }
          subscriber.next(value);
        },
        error(err) {
          void reportClientError({
            source: 'client.streamQuery',
            message: errorMessage(err),
            stack: errorStack(err),
            metadata: { trpcPath: path },
          });
          subscriber.error(err);
        },
        complete() {
          subscriber.complete();
        },
      });

      return () => subscription.unsubscribe();
    });
  }) as Client['streamQuery'],
  mutate: (async (path: any, input: any, opts: any) => {
    const result = await baseClient.mutate(path, input, opts);
    const err = result[1];
    if (err && path !== 'errorReports.report') {
      void reportClientError({
        source: 'client.mutate',
        message: errorMessage(err),
        stack: errorStack(err),
        metadata: { trpcPath: path },
      });
    }
    return result;
  }) as Client['mutate'],
  mutateDynamic: async (path, input, opts) => {
    const result = await baseClient.mutateDynamic(path, input, opts);
    const err = result[1];
    if (err && path !== 'errorReports.report') {
      void reportClientError({
        source: 'client.mutateDynamic',
        message: errorMessage(err),
        stack: errorStack(err),
        metadata: { trpcPath: path },
      });
    }
    return result;
  },
};
