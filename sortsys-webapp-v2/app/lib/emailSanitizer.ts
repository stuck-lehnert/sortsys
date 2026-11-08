import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { emailContentId, MAX_INLINE_IMAGE_BYTES, safeEmailImageData } from "./emailImages";
import { safeEmailStyles } from "./emailStyles";

const ALLOWED_TAGS = new Set([
  "a", "abbr", "b", "blockquote", "br", "caption", "code", "col", "colgroup",
  "center", "dd", "del", "div", "dl", "dt", "em", "font", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "i", "li", "ol", "p", "pre", "s", "small", "span", "strong", "sub", "sup",
  "table", "tbody", "td", "th", "thead", "tfoot", "tr", "u", "ul",
]);
const DROP_CONTENT = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet",
  "svg", "math", "template", "noscript", "form", "input", "textarea", "button",
  "select", "option", "link", "meta", "base", "audio", "video", "source",
]);
const VOID_TAGS = new Set(["br", "hr", "col"]);

export function escapeEmailHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

export function safeEmailLink(value: string): string | null {
  if (/[\x00-\x20\x7f]/.test(value)) return null;
  try {
    // Relative URLs, credentials and scheme-relative URLs are not email links.
    const url = new URL(value);
    if (!["https:", "http:", "mailto:"].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function sanitizeEmailHtml(html: string, inlineImages = new Map<string, string>()): string {
  return renderEmailHtml(html, inlineImages).html;
}

export function renderEmailHtml(html: string, inlineImages = new Map<string, string>()) {
  if (html.length > 3 * 1024 * 1024) throw new Error("email-too-large");
  // parse5 creates an inert syntax tree: parsing never loads images or runs scripts.
  const root = parseFragment(html);
  let remainingNodes = 50_000;
  let imageBytes = 0;
  let imageCount = 0;
  let blockedImages = 0;
  const inlineImageIds = new Set<string>();
  const checkedImages = new Map<string, string | null>();

  const render = (node: DefaultTreeAdapterMap["childNode"], depth: number): string => {
    if (--remainingNodes < 0 || depth > 80) throw new Error("email-too-large");
    if (node.nodeName === "#text") return escapeEmailHtml((node as DefaultTreeAdapterMap["textNode"]).value);
    if (!("tagName" in node)) return "";

    const tag = node.tagName;
    if (node.namespaceURI !== "http://www.w3.org/1999/xhtml" || DROP_CONTENT.has(tag)) return "";
    const attribute = (name: string) => node.attrs.find(attr => attr.name === name && !attr.namespace)?.value ?? "";
    const styles = () => {
      const legacy: string[] = [];
      for (const [attributeName, property] of [["align", "text-align"], ["valign", "vertical-align"], ["bgcolor", "background-color"], ["color", "color"], ["face", "font-family"]]) {
        const value = attribute(attributeName);
        if (value && !/[;:]/.test(value)) legacy.push(`${property}:${value}`);
      }
      for (const name of ["width", "height"]) {
        const value = attribute(name);
        if (/^\d{1,4}%?$/.test(value)) legacy.push(`${name}:${value.endsWith("%") ? value : value + "px"}`);
      }
      if (tag === "table") {
        const spacing = attribute("cellspacing");
        if (/^\d{1,2}$/.test(spacing)) legacy.push(`border-spacing:${spacing}px`);
      }
      const style = safeEmailStyles([...legacy, attribute("style")].join(";"));
      return style ? ` style="${escapeEmailHtml(style)}"` : "";
    };
    if (tag === "img") {
      const source = attribute("src").trim();
      const id = /^cid:/i.test(source) ? emailContentId(source.slice(4)) : null;
      const candidate = id !== null ? inlineImages.get(id) : source;
      if (candidate && !checkedImages.has(candidate)) checkedImages.set(candidate, safeEmailImageData(candidate));
      const image = candidate ? checkedImages.get(candidate) : null;
      const alt = escapeEmailHtml(attribute("alt"));
      if (image && ++imageCount <= 100 && (imageBytes += image.length * .75) <= MAX_INLINE_IMAGE_BYTES) {
        if (id !== null) inlineImageIds.add(id);
        return `<img src="${escapeEmailHtml(image)}" alt="${alt}"${styles()}>`;
      }
      if (source && !/^(?:cid:|data:)/i.test(source)) blockedImages++;
      return alt ? `<span class="email-image-unavailable">${alt}</span>` : "";
    }

    const children = node.childNodes.map(child => render(child, depth + 1)).join("");
    if (!ALLOWED_TAGS.has(tag)) return children;

    const attrs: string[] = [];
    if (tag === "a") {
      const href = safeEmailLink(attribute("href"));
      if (href) attrs.push(`href="${escapeEmailHtml(href)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer"`);
    }
    if (["td", "th", "col", "colgroup"].includes(tag)) {
      for (const name of ["colspan", "rowspan", "span"]) {
        const value = attribute(name);
        if (/^[1-9][0-9]?$/.test(value)) attrs.push(`${name}="${value}"`);
      }
    }
    if (tag === "table" && /^(?:presentation|none)$/.test(attribute("role"))) attrs.push('role="presentation"');
    if (tag === "table" && /^\d{1,2}$/.test(attribute("cellpadding"))) attrs.push(`cellpadding="${attribute("cellpadding")}"`);
    const dir = attribute("dir");
    if (["ltr", "rtl", "auto"].includes(dir)) attrs.push(`dir="${dir}"`);
    const attributes = attrs.length ? " " + attrs.join(" ") : "";
    const outputTag = tag === "font" ? "span" : tag;
    return `<${outputTag}${attributes}${styles()}>${VOID_TAGS.has(tag) ? "" : children + `</${outputTag}>`}`;
  };

  const output = root.childNodes.map(node => render(node, 0)).join("");
  return { html: output, blockedImages, inlineImageIds };
}

export function emailPreviewDocument(html: string, lang = "de"): string {
  return `<!doctype html><html lang="${escapeEmailHtml(lang)}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; connect-src 'none';">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light}*{box-sizing:border-box}body{font:15px/1.6 system-ui,sans-serif;color:#202936;background:#fff;margin:0;padding:28px 32px;overflow-wrap:anywhere}
main{max-width:1000px;margin:0 auto}img{max-width:100%!important;height:auto!important;vertical-align:middle}table{border-collapse:collapse;max-width:100%!important}td,th{vertical-align:top}th{text-align:start}td p,th p{margin:0 0 .65em}p{margin:0 0 1em}h1,h2,h3{line-height:1.3}pre{font:inherit;white-space:pre-wrap;margin:0}code{font-family:monospace}blockquote{border-inline-start:3px solid #cbd5e1;margin:1.25em 0;padding-inline-start:16px;color:#526174}hr{border:0;border-top:1px solid #dce2e9;margin:1.5em 0}a{color:#075cbe;text-decoration:underline;text-underline-offset:2px}a:hover{color:#003e87}.email-image-unavailable{display:inline-block;max-width:100%;padding:4px 8px;border:1px solid #dce2e9;color:#526174;font-size:13px}
@media(max-width:600px){body{padding:20px 16px}}
</style>
</head><body><main>${html}</main></body></html>`;
}
