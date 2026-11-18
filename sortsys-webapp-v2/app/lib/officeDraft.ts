import { openCryptPad } from "./cryptpadBridge";

type BridgeOptions = Parameters<typeof openCryptPad>[0];
type ExportFormat = Parameters<ReturnType<typeof openCryptPad>["export"]>[0];
type Application = BridgeOptions["application"];

const MIME: Partial<Record<ExportFormat, string>> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  csv: "text/csv",
  txt: "text/plain",
  drawio: "application/x-drawio",
};

export class OfficeDraftUnavailable extends Error {
  constructor() {
    super("The shared Office draft could not be read");
  }
}

export function officeDraftFormat(fileName: string, application: Application) {
  const extension = fileName.split(".").at(-1)?.toLowerCase() ?? "";
  let format: ExportFormat;
  if (application === "diagram") {
    format = "drawio";
  } else if (
    ["docx", "xlsx", "pptx", "odt", "ods", "odp", "csv", "txt"].includes(
      extension,
    )
  ) {
    format = extension as ExportFormat;
  } else if (application === "sheet") {
    format = "xlsx";
  } else if (application === "presentation") {
    format = "pptx";
  } else {
    format = "docx";
  }
  const stem = fileName.includes(".")
    ? fileName.slice(0, fileName.lastIndexOf("."))
    : fileName;
  return { format, fileName: `${stem}.${format}`, mime: MIME[format]! };
}

type DraftOptions = Pick<
  BridgeOptions,
  "iframe" | "editorOrigin" | "document" | "fileName" | "application" | "locale"
> & { viewKey: string; signal: AbortSignal };

/** Read an old encrypted room with its view capability. The replacement room
 * gets its own keys; this bridge cannot publish a room or confirm a file save. */
export function readOfficeDraft(options: DraftOptions): Promise<Blob> {
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let bridge: ReturnType<typeof openCryptPad> | undefined;
    let finished = false;
    let exporting = false;
    const finish = (error: unknown, document?: Blob) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", aborted);
      bridge?.close();
      if (error !== undefined) reject(error);
      else resolve(document!);
    };
    const aborted = () =>
      finish(
        options.signal.reason ?? new DOMException("Aborted", "AbortError"),
      );
    const timeout = setTimeout(
      () => finish(new OfficeDraftUnavailable()),
      120_000,
    );
    options.signal.addEventListener("abort", aborted, { once: true });
    try {
      bridge = openCryptPad({
        ...options,
        canEdit: false,
        accessKey: options.viewKey,
        requireExistingSession: true,
        publishSession: async () => {
          throw new OfficeDraftUnavailable();
        },
        save: async () => {
          throw new OfficeDraftUnavailable();
        },
        onError: () => finish(new OfficeDraftUnavailable()),
        onReady: () => {
          if (finished || exporting) return;
          exporting = true;
          const { format, mime } = officeDraftFormat(
            options.fileName,
            options.application,
          );
          void bridge!.export(format).then(
            (document) =>
              finish(undefined, new Blob([document], { type: mime })),
            () => finish(new OfficeDraftUnavailable()),
          );
        },
      });
    } catch {
      finish(new OfficeDraftUnavailable());
    }
  });
}
