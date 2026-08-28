import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLocation,
} from "react-router";

import "@fontsource-variable/jetbrains-mono";
import "@fontsource/ubuntu/400.css";
import "@fontsource/ubuntu/500.css";
import "@fontsource/ubuntu/700.css";
import "@sortsys/react-components/styles.css";
import "@sortsys/dwgviewer/styles.css";
import "./app.css";

import type { Route } from "./+types/root";
import { useEffect, useState, type ReactNode } from "react";
import { client, reportClientError } from "./lib/client";
import { SessionInfoProvider } from "./hooks/useSessionInfo";
import { Loading } from "@sortsys/react-components";
import { useForceUpdate } from "./hooks/useForceUpdate";
import { MyModalsProvider } from "./hooks/useMyModals";
import { useTheme } from "./hooks/useTheme";
import { I18nProvider, uiText, useI18n } from "./lib/i18n";

export const links: Route.LinksFunction = () => [
  {
    rel: 'icon',
    href: '/icon-black-192x192.png',
    type: 'image/png',
  },
  {
    rel: 'manifest',
    href: '/manifest.webmanifest',
  },
];

export const meta: Route.MetaFunction = () => [
];

function ThemeHandler(): undefined {
  const theme = useTheme();

  useEffect(() => {
    if (typeof window !== 'object') return;

    if (theme === 'dark') {
      document.body.classList.add('ss-theme-dark');
      changeFavicon('/icon-white-192x192.png');
      changeThemeColor('#161616');
    } else {
      document.body.classList.remove('ss-theme-dark');
      changeFavicon('/icon-black-192x192.png');
      changeThemeColor('#ffffff');
    }
  }, [theme]);

  return;
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />

        <ThemeHandler />
      </body>
    </html>
  );
}

function _AppInner() {
  return <MyModalsProvider>
    <ClientErrorReporter />
    <Outlet />
  </MyModalsProvider>;
}

function serializeUnknownError(error: unknown) {
  if (error instanceof Error) {
    return {
      message: error.message || error.name || uiText('Unbekannter Fehler'),
      stack: error.stack ?? null,
    };
  }

  return {
    message: `${error || uiText('Unbekannter Fehler')}`,
    stack: null,
  };
}

function ClientErrorReporter(): undefined {
  const location = useLocation();

  useEffect(() => {
    if (typeof window !== 'object') return;

    const onError = (event: ErrorEvent) => {
      const serialized = serializeUnknownError(event.error ?? event.message);
      void reportClientError({
        source: 'window.error',
        message: serialized.message,
        stack: serialized.stack,
        path: `${window.location.pathname}${window.location.search}${window.location.hash}`,
        metadata: {
          fileName: event.filename || null,
          line: event.lineno || null,
          column: event.colno || null,
        },
      });
    };

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      const serialized = serializeUnknownError(event.reason);
      void reportClientError({
        source: 'window.unhandledrejection',
        message: serialized.message,
        stack: serialized.stack,
        path: `${window.location.pathname}${window.location.search}${window.location.hash}`,
      });
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
    };
  }, [location.pathname, location.search, location.hash]);

  return;
}

function AppContent() {
  const { setLocale, t } = useI18n();
  const [restored, setRestored] = useState(false);
  const forceUpdate = useForceUpdate();
  const location = useLocation();
  const isGlobalAdminSpace = location.pathname.startsWith('/__admin');

  useEffect(() => {
    client.restoreSession().finally(() => setRestored(true));
  }, []);

  useEffect(() => client.listenAuthState(() => {
    if (!client.loggedIn()) setLocale('de');
    forceUpdate();
  }), [forceUpdate, setLocale]);

  if (!restored) {
    return (
      <div className="app-session-loading-overlay">
        <Loading active className="app-session-loading" description={t("common.loading")} />
      </div>
    );
  }

  if (isGlobalAdminSpace) return <_AppInner />;

  if (!client.loggedIn()) return <_AppInner />;

  return <SessionInfoProvider>
    <_AppInner />
  </SessionInfoProvider>;
}

export default function App() {
  return <I18nProvider>
    <AppContent />
  </I18nProvider>;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "The requested page could not be found."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  useEffect(() => {
    if (isRouteErrorResponse(error)) {
      void reportClientError({
        source: 'react-router.errorBoundary',
        message: `${error.status} ${error.statusText}`.trim(),
        path: typeof window === 'object' ? `${window.location.pathname}${window.location.search}${window.location.hash}` : null,
        metadata: { status: error.status, data: error.data },
      });
      return;
    }

    const serialized = serializeUnknownError(error);
    void reportClientError({
      source: 'react-router.errorBoundary',
      message: serialized.message,
      stack: serialized.stack,
      path: typeof window === 'object' ? `${window.location.pathname}${window.location.search}${window.location.hash}` : null,
    });
  }, [error]);

  return (
    <main className="pt-16 p-4 container mx-auto">
      <h1>{message}</h1>
      <p>{details}</p>
      {stack && (
        <pre className="w-full p-4 overflow-x-auto">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}

function changeFavicon(src: string) {
  let link: HTMLLinkElement | null = document.querySelector("link[rel~='icon']");

  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }

  link.href = src;
}

function changeThemeColor(themeColor: string) {
  let meta: HTMLMetaElement | null = document.querySelector("meta[name='theme-color']");

  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }

  meta.content = themeColor;
}
