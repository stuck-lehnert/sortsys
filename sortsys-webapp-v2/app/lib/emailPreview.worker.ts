import { parseEmail } from "./emailPreview";

self.onmessage = async (event: MessageEvent<{ bytes: ArrayBuffer; format: "eml" | "msg" }>) => {
  try {
    const mail = await parseEmail(event.data.bytes, event.data.format);
    self.postMessage({ mail }, { transfer: mail.attachments.map(attachment => attachment.content) });
  } catch (error) {
    const code = error instanceof Error && error.message === "email-too-large"
      ? "email-too-large"
      : "invalid-email";
    self.postMessage({ error: code });
  }
};
