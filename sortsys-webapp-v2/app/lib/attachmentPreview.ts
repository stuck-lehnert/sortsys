export type EmailFormat = "eml" | "msg";
export const MAX_EMAIL_BYTES = 25 * 1024 * 1024;
export const MAX_EMAIL_BODY_LENGTH = 3 * 1024 * 1024;

export function attachmentPreviewKind(file: { fileName: string; mimeType: string }): "pdf" | EmailFormat | null {
  const extension = file.fileName.toLowerCase().split(".").pop();
  const mimeType = file.mimeType.toLowerCase().split(";")[0]?.trim();
  if (extension === "pdf" || mimeType === "application/pdf") return "pdf";
  if (extension === "msg" || mimeType === "application/vnd.ms-outlook") return "msg";
  if (extension === "eml" || mimeType === "message/rfc822") return "eml";
  return null;
}
