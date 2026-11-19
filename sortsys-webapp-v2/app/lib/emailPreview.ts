import PostalMime, { type Address } from "postal-mime";
import MsgReaderModule from "@kenjiuno/msgreader";
import { emailHtmlText, renderEmailHtml } from "./emailSanitizer";
import { MAX_EMAIL_BODY_LENGTH, MAX_EMAIL_BYTES, type EmailFormat } from "./attachmentPreview";
import { emailContentId, MAX_INLINE_IMAGE_BYTES, rasterImageType } from "./emailImages";
import { decodeMsgHtml, supportedMsgEncoding } from "./msgTextEncoding";
import { decompressMsgRtf, rtfToText } from "./msgRtf";

// The CommonJS package is a constructor in Bun, but its browser bundle exposes
// an object containing that constructor as `default`.
function msgReaderConstructor(
  imported: typeof MsgReaderModule | { default: typeof MsgReaderModule },
) {
  return typeof imported === "function" ? imported : imported.default;
}

const MsgReader = msgReaderConstructor(MsgReaderModule);

export type EmailAttachment = {
  fileName: string;
  mimeType: string;
  contentId: string | null;
  content: ArrayBuffer;
  inline?: boolean;
};

export type EmailPreview = {
  subject: string;
  from: string;
  to: string;
  cc: string;
  date: string;
  text: string;
  html: string;
  attachments: EmailAttachment[];
  blockedImages: number;
};

function addresses(values: Address[] = []): string {
  return values.map(value => value.group
    ? addresses(value.group)
    : [value.name, value.address ? `<${value.address}>` : ""].filter(Boolean).join(" "),
  ).join(", ");
}

export function safeEmailFileName(value: string): string {
  return value.split(/[\\/]/).pop()?.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 180) || "attachment";
}

function bytes(value: ArrayBuffer | Uint8Array | string): ArrayBuffer {
  if (typeof value === "string") throw new Error("invalid-email");
  return value instanceof ArrayBuffer ? value : new Uint8Array(value).buffer;
}

async function decodeEmail(
  bytesIn: ArrayBuffer,
  format: EmailFormat,
  includeAttachments: boolean,
): Promise<EmailPreview> {
  if (bytesIn.byteLength > MAX_EMAIL_BYTES) throw new Error("email-too-large");
  if (!bytesIn.byteLength) throw new Error("invalid-email");

  let result: EmailPreview;
  if (format === "eml") {
    const mail = await PostalMime.parse(bytesIn, {
      maxNestingDepth: 40,
      maxHeadersSize: 256 * 1024,
      maxRfc822NestingDepth: 3,
      forceRfc822Attachments: true,
    });
    // Do not present arbitrary uploaded text as a successfully decoded email.
    if (!mail.headers.some(header => ["from", "to", "subject", "date", "mime-version"].includes(header.key))) {
      throw new Error("invalid-email");
    }
    if (mail.attachments.length > 100) throw new Error("email-too-large");

    result = {
      subject: mail.subject ?? "",
      from: mail.from ? addresses([mail.from]) : "",
      to: addresses(mail.to),
      cc: addresses(mail.cc),
      date: mail.date ?? "",
      text: mail.text ?? "",
      html: mail.html ?? "",
      attachments: includeAttachments ? mail.attachments.map(attachment => ({
        fileName: safeEmailFileName(attachment.filename ?? "attachment"),
        mimeType: attachment.mimeType,
        contentId: attachment.contentId ?? null,
        content: bytes(attachment.content),
      })) : [],
      blockedImages: 0,
    };
  } else {
    let reader = new MsgReader(bytesIn);
    reader.parserConfig = { ansiEncoding: "windows-1252" };
    let mail = reader.getFileData();
    if (mail.error || mail.dataType !== "msg") throw new Error("invalid-email");
    const messageEncoding = mail.messageCodepage ? supportedMsgEncoding(String(mail.messageCodepage)) : null;
    if (messageEncoding && messageEncoding !== "windows-1252") {
      reader = new MsgReader(bytesIn);
      reader.parserConfig = { ansiEncoding: messageEncoding };
      mail = reader.getFileData();
    }
    if (mail.error || mail.dataType !== "msg") throw new Error("invalid-email");
    if ((mail.attachments?.length ?? 0) > 100) throw new Error("email-too-large");

    const recipients = (type: "to" | "cc") => (mail.recipients ?? [])
      .filter(recipient => recipient.recipType === type || (type === "to" && !recipient.recipType))
      .map(recipient => [recipient.name, recipient.smtpAddress ?? recipient.email].filter(Boolean).join(" "))
      .join(", ");
    // Outlook stores HTML as either Unicode text or a byte stream with a code page.
    const htmlCharset = mail.html
      ? /charset\s*=\s*["']?([a-z0-9_-]+)/i.exec(new TextDecoder().decode(mail.html.subarray(0, 4096)))?.[1]
      : undefined;
    const html = mail.bodyHtml ?? (mail.html
      ? decodeMsgHtml(mail.html, mail.internetCodepage, htmlCharset)
      : "");
    const transport = mail.headers ? await PostalMime.parse(mail.headers + "\r\n\r\n", {
      maxHeadersSize: 256 * 1024,
    }).catch(() => null) : null;
    result = {
      subject: mail.subject ?? "",
      from: [mail.senderName, mail.senderSmtpAddress ?? mail.senderEmail].filter(Boolean).join(" ")
        || (transport?.from ? addresses([transport.from]) : ""),
      to: recipients("to") || addresses(transport?.to),
      cc: recipients("cc") || addresses(transport?.cc),
      date: mail.clientSubmitTime ?? mail.messageDeliveryTime ?? transport?.date ?? "",
      text: mail.body || (!html && mail.compressedRtf ? rtfToText(decompressMsgRtf(mail.compressedRtf)) : ""),
      html,
      attachments: includeAttachments ? (mail.attachments ?? []).map(attachment => {
        const extracted = reader.getAttachment(attachment);
        return {
          fileName: safeEmailFileName(extracted.fileName),
          mimeType: attachment.attachMimeTag ?? "application/octet-stream",
          contentId: attachment.pidContentId ?? null,
          content: new Uint8Array(extracted.content).buffer,
        };
      }) : [],
      blockedImages: 0,
    };
  }

  if (result.html.length > MAX_EMAIL_BODY_LENGTH || result.text.length > MAX_EMAIL_BODY_LENGTH) {
    throw new Error("email-too-large");
  }
  return result;
}

export async function extractEmailText(
  bytesIn: ArrayBuffer,
  format: EmailFormat,
): Promise<string> {
  const { subject, from, to, cc, text, html } = await decodeEmail(bytesIn, format, false);
  const body = html ? emailHtmlText(html) : text.trim();
  return [subject, from, to, cc, body].filter(Boolean).join("\n");
}

export async function parseEmail(bytesIn: ArrayBuffer, format: EmailFormat): Promise<EmailPreview> {
  const result = await decodeEmail(bytesIn, format, true);
  const images = new Map<string, string>();
  let imageBytes = 0;
  for (const attachment of result.attachments) {
    if (!attachment.contentId || !isSafeInlineImage(attachment)) continue;
    if (imageBytes + attachment.content.byteLength > MAX_INLINE_IMAGE_BYTES) continue;
    imageBytes += attachment.content.byteLength;
    const raw = new Uint8Array(attachment.content);
    let binary = "";
    for (let offset = 0; offset < raw.length; offset += 8192) {
      binary += String.fromCharCode(...raw.subarray(offset, offset + 8192));
    }
    const id = emailContentId(attachment.contentId);
    // Duplicate Content-IDs are ambiguous; retain the first embedded resource.
    if (!images.has(id)) images.set(id, `data:${rasterImageType(attachment.content)};base64,${btoa(binary)}`);
  }

  const rendered = renderEmailHtml(result.html, images);
  result.html = rendered.html;
  result.blockedImages = rendered.blockedImages;
  for (const attachment of result.attachments) {
    attachment.inline = !!attachment.contentId && rendered.inlineImageIds.has(emailContentId(attachment.contentId)) && isSafeInlineImage(attachment);
  }
  return result;
}

// SVG and HTML are deliberately excluded, including files mislabeled as PNG.
export function isSafeInlineImage(attachment: EmailAttachment): boolean {
  const type = rasterImageType(attachment.content);
  return !!type && [type, "application/octet-stream"].includes(attachment.mimeType.toLowerCase());
}
