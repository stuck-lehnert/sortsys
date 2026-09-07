import { useCallback } from "react";
import { useNotifications } from "@sortsys/react-components";

import { uiText } from "~/lib/i18n";
import { Icons } from "~/lib/icons";

export type CredentialNotificationField = {
  label: string;
  value: string;
};

export type CredentialNotification = {
  title: string;
  description?: string;
  fields: CredentialNotificationField[];
};

export function useCredentialNotification() {
  const notifications = useNotifications();

  return useCallback((notification: CredentialNotification) => {
    const copyValue = notification.fields
      .map(field => `${field.label}: ${field.value}`)
      .join("\n");

    notifications.success({
      title: notification.title,
      content: <>
        {!!notification.description && <div>{notification.description}</div>}

        <dl className="credential-notification-fields">
          {notification.fields.map(field => <div key={field.label}>
            <dt>{field.label}</dt>
            <dd><code>{field.value}</code></dd>
          </div>)}
        </dl>
      </>,
      duration: null,
      renderIcon: Icons.SetPassword,
      actions: [{
        label: uiText("Kopieren", "Copy"),
        closeOnClick: false,
        onClick: () => {
          const clipboardRequest = typeof navigator === "object" && navigator.clipboard
            ? navigator.clipboard.writeText(copyValue)
            : Promise.reject(new Error("Clipboard API unavailable"));

          void clipboardRequest.then(() => {
            notifications.success({
              id: "credentials-copied",
              title: uiText("Zugangsdaten kopiert", "Credentials copied"),
            });
          }).catch(() => {
            notifications.danger({
              id: "credentials-copy-failed",
              title: uiText("Kopieren fehlgeschlagen", "Copy failed"),
              content: uiText(
                "Die Zugangsdaten konnten nicht in die Zwischenablage kopiert werden.",
                "The credentials could not be copied to the clipboard.",
              ),
            });
          });
        },
      }],
    });
  }, [notifications]);
}
