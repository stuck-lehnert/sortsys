import { useEffect, useRef, useState } from "react";
import { Tile, useNotifications } from "@sortsys/react-components";
import { FileResourceImage } from "./FileResourceImage";
import { MyButton } from "./MyButton";
import { MyCallout } from "./MyCallout";
import { useClientStream } from "~/hooks/useClientStream";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { client, organizationLogo } from "~/lib/client";
import { uiText } from "~/lib/i18n";
import { Icons } from "~/lib/icons";

export function OrganizationLogoSettings() {
  const session = useSessionInfo();
  const canRead = session.canAccess("organization", "attachment", "read");
  const canUpdate = session.canAccess("organization", "attachment", "update");
  const [logo, error] = useClientStream(
    () => client.streamQuery("settings.tenantLogo.get", undefined),
    [],
  );
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const uploadController = useRef<AbortController | null>(null);
  const notifications = useNotifications();
  useEffect(() => () => uploadController.current?.abort(), []);

  async function upload(file: File | null) {
    if (!file || !canUpdate || uploadController.current) return;
    const controller = new AbortController();
    uploadController.current = controller;
    setPending(file);
    setFailure(null);
    setSaving(true);
    try {
      await organizationLogo.upload(file, controller.signal);
      controller.signal.throwIfAborted();
      setPending(null);
      notifications.success({
        title: uiText(
          "Organisationslogo aktualisiert",
          "Organization logo updated",
        ),
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        setFailure(
          error instanceof Error
            ? error.message
            : uiText("Logo-Upload fehlgeschlagen.", "Logo upload failed."),
        );
      }
    } finally {
      uploadController.current = null;
      if (!controller.signal.aborted) setSaving(false);
    }
  }

  if (!canRead)
    return (
      <MyCallout color="yellow">
        {uiText(
          "Das Organisationslogo ist nicht freigegeben.",
          "The organization logo is not shared with this account.",
        )}
      </MyCallout>
    );
  let preview = (
    <p className="text-muted">
      {uiText(
        "Noch kein Organisationslogo verfügbar.",
        "No organization logo available yet.",
      )}
    </p>
  );
  if (logo?.status === "ready" && logo.downloadUrl) {
    preview = (
      <div className="max-w-sm border border-separator bg-white p-3">
        <FileResourceImage
          src={logo.downloadUrl}
          alt={uiText("Organisationslogo", "Organization logo")}
          className="max-h-32 w-full object-contain"
        />
      </div>
    );
  } else if (!logo && !error) {
    preview = (
      <p role="status">{uiText("Logo wird geladen …", "Loading logo …")}</p>
    );
  }
  return (
    <Tile className="space-y-3">
      <input
        ref={input}
        type="file"
        accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
        className="hidden"
        aria-label={uiText("Logo auswählen", "Choose logo")}
        onChange={(event) => {
          void upload(event.target.files?.[0] ?? null);
        }}
      />
      {(failure || error) && (
        <MyCallout icon={Icons.Deny} color="red">
          {failure ?? error?.message}
        </MyCallout>
      )}
      {logo?.status === "failed" && (
        <MyCallout color="yellow">
          {uiText(
            "Das bisherige Organisationslogo war noch nicht fertig verarbeitet. Bitte ein neues Bild auswählen.",
            "The previous organization logo was not fully processed. Choose a new image.",
          )}
        </MyCallout>
      )}
      {canUpdate && (
        <div className="flex flex-wrap gap-2">
          <MyButton
            renderIcon={Icons.Create}
            loading={saving}
            onClick={() => {
              if (!input.current) return;
              input.current.value = "";
              input.current.click();
            }}
          >
            {uiText("Logo hochladen", "Upload logo")}
          </MyButton>
          {!!failure && pending && (
            <MyButton
              kind="secondary"
              disabled={saving}
              onClick={() => {
                void upload(pending);
              }}
            >
              {uiText("Erneut versuchen", "Try again")}
            </MyButton>
          )}
        </div>
      )}
      {preview}
    </Tile>
  );
}
