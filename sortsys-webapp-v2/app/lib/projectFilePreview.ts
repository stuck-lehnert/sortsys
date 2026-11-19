import { attachmentPreviewKind } from "./attachmentPreview";
import type { OfficeApplication } from "./cryptpadBridge";
import { isGaebFile } from "@sortsys/gaeb";
export { isGaebFile as isGaebAttachment } from "@sortsys/gaeb";

type FileMetadata = {
  fileName: string;
  mimeType: string;
  kind?: "file" | "image";
};

export function isDwgAttachment(file: FileMetadata) {
  const fileName = file.fileName.toLowerCase();
  const mimeType = file.mimeType.toLowerCase();

  return (
    fileName.endsWith(".dwg") ||
    mimeType === "application/acad" ||
    mimeType === "application/x-acad" ||
    mimeType === "application/autocad_dwg" ||
    mimeType === "image/vnd.dwg" ||
    mimeType.includes("dwg")
  );
}

const spreadsheetExtensions = new Set([
  "csv", "et", "ett", "fods", "numbers", "ods", "ots", "sxc",
  "xls", "xlsb", "xlsm", "xlsx", "xlt", "xltm", "xltx",
]);

const presentationExtensions = new Set([
  "dps", "dpt", "fodp", "key", "odp", "otp", "pot", "potm", "potx",
  "pps", "ppsm", "ppsx", "ppt", "pptm", "pptx", "sxi",
]);

const documentExtensions = new Set([
  "djvu", "doc", "docm", "docx", "dot", "dotm", "dotx", "epub", "fb2",
  "fodt", "hml", "htm", "html", "hwp", "hwpx", "md", "mht", "mhtml",
  "odg", "odt", "ott", "oxps", "pages", "rtf", "stw", "sxw", "txt",
  "vsdm", "vsdx", "vssm", "vssx", "vstm", "vstx", "wps", "wpt", "xps",
]);

export function projectFileEditor(
  fileName: string,
): OfficeApplication | undefined {
  const name = fileName.toLowerCase();
  const extension = name.slice(name.lastIndexOf(".") + 1);

  if (name.endsWith(".drawio")) return "diagram";
  if (spreadsheetExtensions.has(extension)) return "sheet";
  if (presentationExtensions.has(extension)) return "presentation";
  if (documentExtensions.has(extension)) return "doc";

  return undefined;
}

export function isVideoAttachment(file: FileMetadata) {
  if (file.mimeType.toLocaleLowerCase().startsWith("video/")) {
    return true;
  }

  const extension = file.fileName.toLocaleLowerCase().split(".").pop();

  return (
    !!extension &&
    new Set([
      "3g2",
      "3gp",
      "avi",
      "m4v",
      "mkv",
      "mov",
      "mp4",
      "mpeg",
      "mpg",
      "ogv",
      "ogg",
      "webm",
    ]).has(extension)
  );
}

export function projectFilePreviewKind(file: FileMetadata) {
  if (isGaebFile(file)) return "gaeb";
  const attachmentKind = attachmentPreviewKind(file);

  if (attachmentKind) {
    return attachmentKind;
  }

  if (isDwgAttachment(file)) {
    return "dwg";
  }

  if (isVideoAttachment(file)) {
    return "video";
  }

  const editor = projectFileEditor(file.fileName);
  if (editor) {
    return editor === "diagram" ? "drawio" : "office";
  }

  return file.kind === "image" ? "image" : null;
}
