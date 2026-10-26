import { attachmentPreviewKind } from "./attachmentPreview";

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

export function isOnlyOfficeAttachment(file: FileMetadata) {
  const extension = file.fileName.toLowerCase().split(".").pop();

  return (
    !!extension &&
    new Set([
      "csv",
      "djvu",
      "doc",
      "docm",
      "docx",
      "dot",
      "dotm",
      "dotx",
      "dps",
      "dpt",
      "epub",
      "et",
      "ett",
      "fb2",
      "fodp",
      "fods",
      "fodt",
      "hml",
      "htm",
      "html",
      "hwp",
      "hwpx",
      "key",
      "md",
      "mht",
      "mhtml",
      "numbers",
      "odg",
      "odp",
      "ods",
      "odt",
      "otp",
      "ots",
      "ott",
      "oxps",
      "pages",
      "pot",
      "potm",
      "potx",
      "pps",
      "ppsm",
      "ppsx",
      "ppt",
      "pptm",
      "pptx",
      "rtf",
      "stw",
      "sxc",
      "sxi",
      "sxw",
      "txt",
      "vsdm",
      "vsdx",
      "vssm",
      "vssx",
      "vstm",
      "vstx",
      "wps",
      "wpt",
      "xls",
      "xlsb",
      "xlsm",
      "xlsx",
      "xlt",
      "xltm",
      "xltx",
      "xps",
    ]).has(extension)
  );
}

export function isDrawioAttachment(file: FileMetadata) {
  return file.fileName.toLocaleLowerCase().endsWith(".drawio");
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

  if (isDrawioAttachment(file)) {
    return "drawio";
  }

  if (isOnlyOfficeAttachment(file)) {
    return "office";
  }

  return file.kind === "image" ? "image" : null;
}
