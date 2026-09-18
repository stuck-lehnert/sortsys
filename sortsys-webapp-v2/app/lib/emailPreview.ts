import PostalMime, { type Address } from "postal-mime";
import MsgReader from "@kenjiuno/msgreader";
import { sanitizeEmailHtml } from "./emailSanitizer";
import { decode } from "./msgTextEncoding";
import { decompressMsgRtf, rtfToText } from "./msgRtf";

export const MAX_EMAIL_BYTES = 25 * 1024 * 1024;
const MAX_BODY_BYTES = 3 * 1024 * 1024;

export type EmailAttachment = {
  fileName: string;
  mimeType: string;
  contentId: string | null;
  content: ArrayBuffer;
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

export async function parseEmail(bytesIn: ArrayBuffer, format: "eml" | "msg"): Promise<EmailPreview> {
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
      attachments: mail.attachments.map(attachment => ({
        fileName: safeEmailFileName(attachment.filename ?? "attachment"),
        mimeType: attachment.mimeType,
        contentId: attachment.contentId ?? null,
        content: bytes(attachment.content),
      })),
    };
  } else {
    let reader = new MsgReader(bytesIn);
    reader.parserConfig = { ansiEncoding: "windows-1252" };
    let mail = reader.getFileData();
    if (mail.error || mail.dataType !== "msg") throw new Error("invalid-email");
    if (mail.messageCodepage && mail.messageCodepage !== 1252) {
      reader = new MsgReader(bytesIn);
      reader.parserConfig = { ansiEncoding: String(mail.messageCodepage) };
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
      ? decode(mail.html, mail.internetCodepage ? String(mail.internetCodepage) : htmlCharset ?? "utf-8")
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
      attachments: (mail.attachments ?? []).map(attachment => {
        const extracted = reader.getAttachment(attachment);
        return {
          fileName: safeEmailFileName(extracted.fileName),
          mimeType: attachment.attachMimeTag ?? "application/octet-stream",
          contentId: attachment.pidContentId ?? null,
          content: new Uint8Array(extracted.content).buffer,
        };
      }),
    };
  }

  if (result.attachments.length > 100 || result.html.length > MAX_BODY_BYTES || result.text.length > MAX_BODY_BYTES) {
    throw new Error("email-too-large");
  }

  const images = new Map<string, string>();
  let imageBytes = 0;
  for (const attachment of result.attachments) {
    if (!attachment.contentId || !isSafeInlineImage(attachment)) continue;
    imageBytes += attachment.content.byteLength;
    if (imageBytes > 8 * 1024 * 1024) break;
    const raw = new Uint8Array(attachment.content);
    let binary = "";
    for (let offset = 0; offset < raw.length; offset += 8192) {
      binary += String.fromCharCode(...raw.subarray(offset, offset + 8192));
    }
    images.set(attachment.contentId.replace(/^<|>$/g, ""), `data:${attachment.mimeType};base64,${btoa(binary)}`);
  }

  result.html = sanitizeEmailHtml(result.html, images);
  return result;
}

// SVG and HTML are deliberately excluded, including files mislabeled as PNG.
export function isSafeInlineImage(attachment: EmailAttachment): boolean {
  const data = new Uint8Array(attachment.content);
  const starts = (...signature: number[]) => signature.every((value, index) => data[index] === value);
  switch (attachment.mimeType.toLowerCase()) {
    case "image/png": return starts(137, 80, 78, 71, 13, 10, 26, 10);
    case "image/jpeg": return starts(255, 216, 255);
    case "image/gif": return starts(71, 73, 70, 56) && (data[4] === 55 || data[4] === 57) && data[5] === 97;
    case "image/webp": return starts(82, 73, 70, 70) && data[8] === 87 && data[9] === 69 && data[10] === 66 && data[11] === 80;
    default: return false;
  }
}
