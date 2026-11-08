import { useEffect, useMemo, useState } from "react";
import type { EmailAttachment, EmailPreview } from "~/lib/emailPreview";
import { emailPreviewDocument, escapeEmailHtml } from "~/lib/emailSanitizer";
import { currentLocaleTag, uiText } from "~/lib/i18n";
import { MyButton } from "./MyButton";
import { MyCallout } from "./MyCallout";
import { Icons } from "~/lib/icons";
import { downloadBlob } from "~/lib/utils";
import "./attachmentViewers.css";

const MAX_EMAIL_BYTES = 25 * 1024 * 1024;

function attachmentSize(size: number): string {
  if (size < 1024) return `${size.toLocaleString(currentLocaleTag())} B`;
  const mb = size >= 1024 * 1024;
  return `${(size / (mb ? 1024 * 1024 : 1024)).toLocaleString(currentLocaleTag(), { maximumFractionDigits: 1 })} ${mb ? "MB" : "KB"}`;
}

function EmailAttachments({ attachments }: { attachments: EmailAttachment[] }) {
  return <ul className="attachment-email-file-list">{attachments.map((attachment, index) => {
    const Icon = attachment.mimeType.startsWith("image/") ? Icons.FileImage
      : attachment.mimeType === "application/pdf" ? Icons.FilePdf : Icons.FileText;
    return <li key={index}><button type="button" className="attachment-email-file" onClick={() =>
      downloadBlob(new Blob([attachment.content], { type: "application/octet-stream" }), attachment.fileName)}
      aria-label={uiText(`${attachment.fileName} herunterladen`, `Download ${attachment.fileName}`)}>
      <Icon size={24} aria-hidden="true" />
      <span className="attachment-email-file-info"><span>{attachment.fileName}</span><small>{attachmentSize(attachment.content.byteLength)}</small></span>
      <Icons.Download size={16} aria-hidden="true" />
    </button></li>;
  })}</ul>;
}

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

export default function EmailAttachmentViewer({ url, format }: {
  url: string; format: "eml" | "msg";
}) {
  const [mail, setMail] = useState<EmailPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    let worker: Worker | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    setMail(null);
    setError(null);

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
  const locale = currentLocaleTag();
  const document = useMemo(() => {
    const body = mail && !mail.html
      ? "<pre>" + escapeEmailHtml(mail.text || uiText("Kein Nachrichtentext vorhanden.", "No message text.")) + "</pre>"
      : mail?.html ?? "";
    return emailPreviewDocument(body, locale);
  }, [mail, locale]);
  const attachments = mail?.attachments.filter(attachment => !attachment.inline) ?? [];
  const inlineImages = mail?.attachments.filter(attachment => attachment.inline) ?? [];

  return <div className="attachment-email-viewer">
    {error && <div className="attachment-viewer-status">
      <MyCallout color="red" icon={Icons.Deny}>
        {error === "email-too-large"
          ? uiText("Die E-Mail ist für die Vorschau zu groß (maximal 25 MB).", "The email is too large to preview (maximum 25 MB).")
          : error === "email-timeout"
            ? uiText("Das Einlesen hat zu lange gedauert.", "Reading the email took too long.")
            : uiText("Die E-Mail konnte nicht eingelesen werden.", "The email could not be read.")}
      </MyCallout>
      <MyButton size="sm" onClick={() => setRetry(value => value + 1)}>{uiText("Erneut versuchen", "Try again")}</MyButton>
    </div>}
    {!mail && !error && <div className="attachment-viewer-status" role="status"><span className="ss-spinner" aria-hidden="true" />{uiText("E-Mail wird eingelesen …", "Reading email …")}</div>}

    {mail && <>
      <header className="attachment-email-metadata">
        <div className="attachment-email-heading">
          <h2>{mail.subject || uiText("Ohne Betreff", "No subject")}</h2>
        </div>
        <div className="attachment-email-sender">
          <span className="attachment-email-avatar" aria-hidden="true"><Icons.Email size={20} /></span>
          <div className="attachment-email-addresses">
            <p className="attachment-email-from"><span className="sr-only">{uiText("Von: ", "From: ")}</span>{mail.from || "–"}</p>
            <dl>
              <dt>{uiText("An", "To")}</dt><dd>{mail.to || "–"}</dd>
              {mail.cc && <><dt>{uiText("Kopie", "Cc")}</dt><dd>{mail.cc}</dd></>}
            </dl>
          </div>
          {mail.date && <time dateTime={date && !Number.isNaN(date.getTime()) ? date.toISOString() : undefined}>
            {date && !Number.isNaN(date.getTime()) ? date.toLocaleString(currentLocaleTag(), { dateStyle: "medium", timeStyle: "short" }) : mail.date}
          </time>}
        </div>
        {!!attachments.length && <section className="attachment-email-attachments" aria-label={uiText("Anhänge", "Attachments")}>
          <h3>{uiText(`Anhänge (${attachments.length})`, `Attachments (${attachments.length})`)}</h3>
          <EmailAttachments attachments={attachments} />
        </section>}
        {!!inlineImages.length && <details className="attachment-email-inline-images">
          <summary>{uiText(`Eingebettete Bilder (${inlineImages.length})`, `Embedded images (${inlineImages.length})`)}</summary>
          <EmailAttachments attachments={inlineImages} />
        </details>}
      </header>
      {!!mail.blockedImages && <div className="attachment-email-privacy">
        <Icons.Lock size={14} aria-hidden="true" />{uiText("Externe Bilder sind blockiert.", "External images are blocked.")}
      </div>}

      {/* No scripts or same-origin access, even if a future sanitizer change misses something. */}
      <iframe className="attachment-email-body" title={uiText("Nachricht", "Message")}
        sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer"
        srcDoc={document} />
    </>}
  </div>;
}
