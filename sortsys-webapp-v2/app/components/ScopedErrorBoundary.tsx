import type { ReactNode } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { MyButton } from "~/components/MyButton";
import { MyCallout } from "~/components/MyCallout";
import { reportClientError } from "~/lib/client";
import { Icons } from "~/lib/icons";
import { uiText } from "~/lib/i18n";

type ScopedErrorBoundaryProps = {
  children: ReactNode;
  resetKey?: string;
  scope: string;
};

export function ScopedErrorBoundary({
  children,
  resetKey,
  scope,
}: ScopedErrorBoundaryProps) {
  return (
    <ErrorBoundary
      resetKeys={resetKey === undefined ? [] : [resetKey]}
      onError={(error, info) => {
        const message = error instanceof Error
          ? error.message || error.name
          : String(error || uiText("Unbekannter Fehler", "Unknown error"));

        void reportClientError({
          source: "react.scopedErrorBoundary",
          message,
          stack: error instanceof Error ? error.stack ?? null : null,
          componentStack: info.componentStack,
          metadata: { scope },
        });
      }}
      fallbackRender={({ resetErrorBoundary }) => (
        <section className="scoped-error-boundary" role="alert">
          <MyCallout icon={Icons.Deny} color="red">
            <div className="scoped-error-boundary__content">
              <strong>
                {uiText(
                  "Dieser Bereich konnte nicht angezeigt werden.",
                  "This section could not be displayed.",
                )}
              </strong>

              <span>
                {uiText(
                  "Versuche es erneut. Der Rest der Seite bleibt geöffnet.",
                  "Try again. The rest of the page will stay open.",
                )}
              </span>

              <MyButton
                kind="secondary"
                size="sm"
                onClick={resetErrorBoundary}
              >
                {uiText("Erneut versuchen", "Try again")}
              </MyButton>
            </div>
          </MyCallout>
        </section>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}
