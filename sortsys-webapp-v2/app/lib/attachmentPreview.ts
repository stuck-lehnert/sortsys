export function attachmentPreviewKind(file: { fileName: string; mimeType: string }): "pdf" | "eml" | "msg" | null {
  const extension = file.fileName.toLowerCase().split(".").pop();
  const mimeType = file.mimeType.toLowerCase().split(";")[0]?.trim();
  if (extension === "pdf" || mimeType === "application/pdf") return "pdf";
  if (extension === "msg" || mimeType === "application/vnd.ms-outlook") return "msg";
  if (extension === "eml" || mimeType === "message/rfc822") return "eml";
  return null;
}
