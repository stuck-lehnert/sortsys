import { extractEmailText, parseEmail } from "./emailPreview";
import type { EmailWorkerRequest, EmailWorkerResponse } from "./emailWorkerClient";

self.onmessage = async (event: MessageEvent<EmailWorkerRequest>) => {
  const { bytes, format, mode } = event.data;
  try {
    if (mode === "text") {
      const value = await extractEmailText(bytes, format);
      self.postMessage({ mode, value } satisfies EmailWorkerResponse);
    } else {
      const value = await parseEmail(bytes, format);
      self.postMessage({ mode, value } satisfies EmailWorkerResponse, {
        transfer: value.attachments.map((attachment) => attachment.content),
      });
    }
  } catch (error) {
    const code = error instanceof Error && error.message === "email-too-large"
      ? "email-too-large"
      : "invalid-email";
    self.postMessage({ error: code } satisfies EmailWorkerResponse);
  }
};
