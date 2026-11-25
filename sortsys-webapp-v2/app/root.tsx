import { Button as UIAction } from "@sortsys/react-components";
import {
  Accordion,
  Card,
  I18nProvider as HeroI18nProvider,
} from "@heroui/react";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLocation,
  useMatch,
  useMatches,
} from "react-router";

import "@fontsource-variable/jetbrains-mono";
import "@fontsource/ubuntu/400.css";
import "@fontsource/ubuntu/500.css";
import "@fontsource/ubuntu/700.css";
import "./theme.css";
import "@sortsys/react-components/styles.css";
import "@sortsys/dwgviewer/styles.css";
import "./app.css";

import type { Route } from "./+types/root";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { authClient, reportClientError } from "./lib/authClient";
import { LLMActivityHost } from "./components/LLMActivityHost";
import { Loading, NotificationProvider } from "@sortsys/react-components";
import { useTheme } from "./hooks/useTheme";
import { I18nProvider, uiText, useI18n } from "./lib/i18n";

const ApplicationFrame = lazy(() => import("./components/ApplicationFrame"));

export const links: Route.LinksFunction = () => [
  {
    rel: "icon",
    href: "/icon-black-192x192.png",
    type: "image/png",
  },
  {
    rel: "manifest",
    href: "/manifest.webmanifest",
  },
];

export const meta: Route.MetaFunction = () => [];

function ThemeHandler(): undefined {
  const theme = useTheme();

  useEffect(() => {
    if (typeof window !== "object") return;

    document.documentElement.dataset.theme = theme;
    document.documentElement.classList.toggle("dark", theme === "dark");

    if (theme === "dark") {
      document.body.classList.add("ss-theme-dark");
      changeFavicon("/icon-white-192x192.png");
      changeThemeColor("#161616");
    } else {
      document.body.classList.remove("ss-theme-dark");
      changeFavicon("/icon-black-192x192.png");
      changeThemeColor("#ffffff");
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

function ClientErrorReporter(): undefined {
  const location = useLocation();

  useEffect(() => {
    if (typeof window !== "object") return;

    const onError = () => {
      void reportClientError({
        source: "window.error",
        path: `${window.location.pathname}${window.location.search}${window.location.hash}`,
      });
    };

    const onUnhandledRejection = () => {
      void reportClientError({
        source: "window.unhandledrejection",
        path: `${window.location.pathname}${window.location.search}${window.location.hash}`,
      });
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, [location.pathname, location.search, location.hash]);

  return;
}

function AppContent() {
  const { setLocale, t } = useI18n();
  const [restored, setRestored] = useState(false);
  const [authVersion, setAuthVersion] = useState(0);
  const { pathname } = useLocation();
  const signIn = useMatch("/auth/login");
  const matches = useMatches();

  useEffect(() => {
    authClient.restoreSession().finally(() => setRestored(true));
  }, []);

  useEffect(
    () =>
      authClient.listenAuthState(() => {
        if (!authClient.loggedIn()) setLocale("de");
        setAuthVersion((version) => version + 1);
      }),
    [setLocale],
  );

  const loading = (
    <div className="app-session-loading-overlay">
      <Loading
        active
        className="app-session-loading"
        description={t("common.loading")}
      />
    </div>
  );
  if (!restored) return loading;

  const content = (
    <>
      <ClientErrorReporter />
      <Outlet />
    </>
  );
  const signedIn = authClient.loggedIn();
  const shell = matches.some(({ id }) => id === "routes/(shell)/_layout");

  // The shell's authentication guard redirects before it renders the outlet.
  // Neither that redirect nor the sign-in form needs the application frame.
  if (signIn || (!signedIn && shell)) return content;

  const requireCrypto =
    signedIn &&
    !pathname.startsWith("/__admin") &&
    pathname !== "/auth/recovery" &&
    pathname !== "/auth/invitation";

  return (
    <Suspense fallback={loading}>
      <ApplicationFrame authVersion={authVersion} requireCrypto={requireCrypto}>
        {content}
      </ApplicationFrame>
    </Suspense>
  );
}

function AppNotificationProvider({ children }: { children: ReactNode }) {
  useI18n();

  return (
    <NotificationProvider
      closeLabel={uiText("Benachrichtigung schließen", "Close notification")}
      regionLabel={uiText("Benachrichtigungen", "Notifications")}
    >
      {children}
    </NotificationProvider>
  );
}

export default function App() {
  return (
    <I18nProvider>
      <AppNotificationProvider>
        <LLMActivityHost />
        <AppContent />
      </AppNotificationProvider>
    </I18nProvider>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = uiText("Etwas ist schiefgegangen.", "Something went wrong.");
  let details = uiText(
    "Die Seite konnte nicht vollständig geladen werden.",
    "The page could not be loaded completely.",
  );
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message =
      error.status === 404
        ? uiText("Seite nicht gefunden", "Page not found")
        : uiText("Fehler beim Laden", "Loading error");
    details =
      error.status === 404
        ? uiText(
            "Die angeforderte Seite gibt es nicht oder nicht mehr.",
            "The requested page does not exist or is no longer available.",
          )
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  useEffect(() => {
    if (isRouteErrorResponse(error)) {
      void reportClientError({
        source: "react-router.errorBoundary",
        path:
          typeof window === "object"
            ? `${window.location.pathname}${window.location.search}${window.location.hash}`
            : null,
        status: error.status,
      });
      return;
    }

    void reportClientError({
      source: "react-router.errorBoundary",
      path:
        typeof window === "object"
          ? `${window.location.pathname}${window.location.search}${window.location.hash}`
          : null,
    });
  }, [error]);

  return (
    <main className="grid min-h-dvh place-items-center bg-background p-4">
      <LLMActivityHost />
      <Card className="w-full max-w-2xl gap-4 p-6" role="alert">
        {isRouteErrorResponse(error) && (
          <div className="text-sm font-medium text-muted">{error.status}</div>
        )}
        <h1 className="text-3xl leading-snug font-semibold">{message}</h1>
        <p>{details}</p>

        <div className="flex flex-wrap items-center gap-3">
          <a
            className="inline-flex min-h-11 items-center text-accent hover:underline"
            href="/"
          >
            {uiText("Zur Startseite", "Go to home")}
          </a>
          <UIAction
            kind="ghost"
            type="button"
            onClick={() => window.location.reload()}
          >
            {uiText("Neu laden", "Reload")}
          </UIAction>
        </div>

        {stack && (
          <Accordion>
            <Accordion.Item id="technical-details">
              <Accordion.Heading level={2}>
                <Accordion.Trigger className="text-sm font-medium">
                  {uiText("Technische Details", "Technical details")}
                  <Accordion.Indicator />
                </Accordion.Trigger>
              </Accordion.Heading>
              <Accordion.Panel>
                <Accordion.Body className="min-w-0 px-0">
                  <pre className="w-full p-4 overflow-x-auto">
                    <code>{stack}</code>
                  </pre>
                </Accordion.Body>
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>
        )}
      </Card>
    </main>
  );
}

function changeFavicon(src: string) {
  let link: HTMLLinkElement | null =
    document.querySelector("link[rel~='icon']");

  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }

  link.href = src;
}

function changeThemeColor(themeColor: string) {
  let meta: HTMLMetaElement | null = document.querySelector(
    "meta[name='theme-color']",
  );

  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }

  meta.content = themeColor;
}
