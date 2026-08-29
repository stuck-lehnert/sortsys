import { Modal } from "@sortsys/react-components";
import { useCallback, useState } from "react";
import { OnlyOfficeEditor } from "~/components/OnlyOfficeEditor";
import { MyCallout } from "~/components/MyCallout";
import { ScopedErrorBoundary } from "~/components/ScopedErrorBoundary";
import type { MyModalsInterface } from "~/hooks/useMyModals";
import { client } from "~/lib/client";
import { Icons } from "~/lib/icons";
import { uiText } from "~/lib/i18n";

const EXCEL_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

type ExportOfficeSession = {
  apiUrl: string;
  canEdit: boolean;
  config: Record<string, unknown>;
};

function ExportOfficeModal({
  fileName,
  hide,
  session,
  visible,
}: {
  fileName: string;
  hide: () => void;
  session: ExportOfficeSession;
  visible: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const close = useCallback(() => hide(), [hide]);

  return (
    <Modal
      open={visible}
      passiveModal
      modalHeading={uiText("Excel-Export", "Excel export")}
      modalLabel={fileName}
      closeButtonLabel={uiText("Schließen", "Close")}
      onRequestClose={close}
      data-fullheight="true"
      data-fullwidth="true"
      className="project-files-office-modal"
    >
      {!!error && (
        <div className="project-files-office-status">
          <MyCallout icon={Icons.Deny} color="red">{error}</MyCallout>
        </div>
      )}

      <ScopedErrorBoundary scope="onlyoffice.export" resetKey={fileName}>
        <OnlyOfficeEditor
          apiUrl={session.apiUrl}
          config={session.config}
          onError={setError}
          onRequestClose={close}
        />
      </ScopedErrorBoundary>
    </Modal>
  );
}

function showExportError(modals: MyModalsInterface, error: unknown) {
  const message = error instanceof Error
    ? error.message
    : uiText("Der Excel-Export ist fehlgeschlagen.", "The Excel export failed.");

  modals.showDefault({
    content: () => <MyCallout icon={Icons.Deny} color="red">{message}</MyCallout>,
    modalProps: () => ({
      passiveModal: true,
      modalHeading: uiText("Excel-Export fehlgeschlagen", "Excel export failed"),
      closeButtonLabel: uiText("Schließen", "Close"),
    }),
  });
}

export async function openExcelExport(
  modals: MyModalsInterface,
  blob: Blob,
  fileName: string,
) {
  try {
    await prepareAndOpenExcelExport(modals, blob, fileName);
  } catch (error) {
    showExportError(modals, error);
  }
}

async function prepareAndOpenExcelExport(
  modals: MyModalsInterface,
  blob: Blob,
  fileName: string,
) {
  const [upload, uploadError] = await client.mutate(
    "office.exports.createUpload",
    {
      fileName,
      mimeType: EXCEL_MIME_TYPE,
      sizeBytes: blob.size,
    },
  );

  if (uploadError || !upload) {
    throw new Error(
      uploadError?.message
        ?? uiText(
          "Der Excel-Export konnte nicht vorbereitet werden.",
          "The Excel export could not be prepared.",
        ),
    );
  }

  const uploadResponse = await fetch(upload.uploadUrl, {
    method: upload.uploadMethod,
    headers: upload.uploadHeaders,
    body: blob,
  });

  if (!uploadResponse.ok) {
    throw new Error(uiText(
      `Der Excel-Export konnte nicht hochgeladen werden (${uploadResponse.status}).`,
      `The Excel export could not be uploaded (${uploadResponse.status}).`,
    ));
  }

  const [session, sessionError] = await client.query(
    "office.exports.officeConfig",
    { sessionToken: upload.sessionToken },
  );

  if (sessionError || !session) {
    throw new Error(
      sessionError?.message
        ?? uiText(
          "Der Excel-Export konnte nicht geöffnet werden.",
          "The Excel export could not be opened.",
        ),
    );
  }

  modals.show(({ visible, hide }) => (
    <ExportOfficeModal
      fileName={fileName}
      hide={hide}
      session={session}
      visible={visible}
    />
  ));
}
