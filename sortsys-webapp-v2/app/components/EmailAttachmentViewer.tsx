import { useEffect, useState } from "react";
import type { EmailPreview } from "~/lib/emailPreview";
import { emailPreviewDocument, escapeEmailHtml } from "~/lib/emailSanitizer";
import { currentLocaleTag, uiText } from "~/lib/i18n";
import { MyButton } from "./MyButton";
import { MyCallout } from "./MyCallout";
import { Icons } from "~/lib/icons";
import { downloadBlob } from "~/lib/utils";
import "./attachmentViewers.css";

const MAX_EMAIL_BYTES = 25 * 1024 * 1024;

async function readEmailBytes(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(url, { signal, credentials: "omit" });
  if (!response.ok || !response.body) throw new Error("email-download-failed");
  if (Number(response.headers.get("content-length")) > MAX_EMAIL_BYTES) throw new Error("email-too-large");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_EMAIL_BYTES) throw new Error("email-too-large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}

export default function EmailAttachmentViewer({ url, format, downloadUrl }: {
  url: string; format: "eml" | "msg"; downloadUrl: string;
}) {
  const [mail, setMail] = useState<EmailPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [plainText, setPlainText] = useState(false);

  useEffect(() => {
    const abort = new AbortController();
    let worker: Worker | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    setMail(null);
    setError(null);
    setPlainText(false);

    void (async () => {
      const bytes = await readEmailBytes(url, abort.signal);
      if (abort.signal.aborted) return;
      // A worker can be terminated if a malformed compound file stalls its parser.
      worker = new Worker(new URL("../lib/emailPreview.worker.ts", import.meta.url), { type: "module" });
      const parsed = await new Promise<EmailPreview>((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("email-timeout")), 20_000);
        abort.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        worker!.onmessage = (event: MessageEvent<{ mail?: EmailPreview; error?: string }>) => {
          if (event.data.mail) resolve(event.data.mail);
          else reject(new Error(event.data.error ?? "invalid-email"));
        };
        worker!.onerror = () => reject(new Error("invalid-email"));
        worker!.postMessage({ bytes, format }, [bytes]);
      });
      if (!abort.signal.aborted) setMail(parsed);
    })().catch(cause => {
      if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "invalid-email");
    }).finally(() => { worker?.terminate(); clearTimeout(timeout); });

    return () => { abort.abort(); worker?.terminate(); clearTimeout(timeout); };
  }, [url, format, retry]);

  const date = mail?.date ? new Date(mail.date) : null;
  const body = mail && (plainText || !mail.html)
    ? "<pre>" + escapeEmailHtml(mail.text || uiText("Kein Nachrichtentext vorhanden.", "No message text.")) + "</pre>"
    : mail?.html ?? "";

  return <div className="attachment-email-viewer">
    <div className="attachment-viewer-toolbar">
      {mail?.html && mail.text && <MyButton size="sm" kind="ghost" onClick={() => setPlainText(value => !value)}>
        {plainText ? uiText("Formatierte Ansicht", "Formatted view") : uiText("Nur Text", "Plain text")}
      </MyButton>}
      <a href={downloadUrl} target="_blank" rel="noopener noreferrer">{uiText("Original herunterladen", "Download original")}</a>
    </div>

    {error && <div className="attachment-viewer-status">
      <MyCallout color="red" icon={Icons.Deny}>
        {error === "email-too-large"
          ? uiText("Die E-Mail ist für die Vorschau zu groß (maximal 25 MB).", "The email is too large to preview (maximum 25 MB).")
          : error === "email-timeout"
            ? uiText("Das Einlesen hat zu lange gedauert.", "Reading the email took too long.")
            : uiText("Die E-Mail konnte nicht eingelesen werden. Du kannst die Originaldatei herunterladen.", "The email could not be read. You can download the original file.")}
      </MyCallout>
      <MyButton size="sm" onClick={() => setRetry(value => value + 1)}>{uiText("Erneut versuchen", "Try again")}</MyButton>
    </div>}
    {!mail && !error && <div className="attachment-viewer-status" role="status">{uiText("E-Mail wird eingelesen …", "Reading email …")}</div>}

    {mail && <>
      <div className="attachment-email-metadata">
        <strong>{mail.subject || uiText("Ohne Betreff", "No subject")}</strong>
        <dl>
          <dt>{uiText("Von", "From")}</dt><dd>{mail.from || "–"}</dd>
          <dt>{uiText("An", "To")}</dt><dd>{mail.to || "–"}</dd>
          {mail.cc && <><dt>{uiText("Kopie", "Cc")}</dt><dd>{mail.cc}</dd></>}
          <dt>{uiText("Datum", "Date")}</dt><dd>{date && !Number.isNaN(date.getTime())
            ? date.toLocaleString(currentLocaleTag()) : mail.date || "–"}</dd>
        </dl>
        {!!mail.attachments.length && <details className="attachment-email-attachments">
          <summary>{uiText(`Anhänge (${mail.attachments.length})`, `Attachments (${mail.attachments.length})`)}</summary>
          <ul>{mail.attachments.map((attachment, index) => <li key={index}>
            <MyButton size="sm" kind="ghost" renderIcon={Icons.Download} onClick={() =>
              downloadBlob(new Blob([attachment.content], { type: "application/octet-stream" }), attachment.fileName)}>
              {attachment.fileName}
            </MyButton>
            <span>{(attachment.content.byteLength / 1024).toLocaleString(currentLocaleTag(), { maximumFractionDigits: 1 })} {uiText("KB", "KB")}</span>
          </li>)}</ul>
        </details>}
      </div>

      {/* No scripts or same-origin access, even if a future sanitizer change misses something. */}
      <iframe className="attachment-email-body" title={uiText("Nachricht", "Message")}
        sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer"
        srcDoc={emailPreviewDocument(body)} />
    </>}
  </div>;
}
