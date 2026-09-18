import { parseFragment, type DefaultTreeAdapterMap } from "parse5";

const ALLOWED_TAGS = new Set([
  "a", "abbr", "b", "blockquote", "br", "caption", "code", "col", "colgroup",
  "dd", "del", "div", "dl", "dt", "em", "h1", "h2", "h3", "h4", "h5", "h6",
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
  // parse5 creates an inert syntax tree: parsing never loads images or runs scripts.
  const root = parseFragment(html);
  let remainingNodes = 50_000;

  const render = (node: DefaultTreeAdapterMap["childNode"], depth: number): string => {
    if (--remainingNodes < 0 || depth > 80) throw new Error("email-too-large");
    if (node.nodeName === "#text") return escapeEmailHtml((node as DefaultTreeAdapterMap["textNode"]).value);
    if (!("tagName" in node)) return "";

    const tag = node.tagName;
    if (node.namespaceURI !== "http://www.w3.org/1999/xhtml" || DROP_CONTENT.has(tag)) return "";
    const attribute = (name: string) => node.attrs.find(attr => attr.name === name && !attr.namespace)?.value ?? "";
    if (tag === "img") {
      const source = attribute("src");
      const image = /^cid:/i.test(source) ? inlineImages.get(source.slice(4).replace(/^<|>$/g, "")) : null;
      const alt = escapeEmailHtml(attribute("alt"));
      return image && /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(image)
        ? `<img src="${escapeEmailHtml(image)}" alt="${alt}">` : alt;
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
    const dir = attribute("dir");
    if (["ltr", "rtl", "auto"].includes(dir)) attrs.push(`dir="${dir}"`);
    const attributes = attrs.length ? " " + attrs.join(" ") : "";
    return `<${tag}${attributes}>${VOID_TAGS.has(tag) ? "" : children + `</${tag}>`}`;
  };

  return root.childNodes.map(node => render(node, 0)).join("");
}

export function emailPreviewDocument(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; connect-src 'none';">
<meta name="referrer" content="no-referrer">
<style>body{font:15px/1.5 system-ui,sans-serif;color:#222;background:#fff;margin:20px;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{border-collapse:collapse;max-width:100%}td,th{border:1px solid #ddd;padding:6px;vertical-align:top}pre{white-space:pre-wrap}blockquote{border-left:3px solid #ddd;margin-left:0;padding-left:12px}a{color:#165da6;text-decoration:none}a:hover{opacity:.8}</style>
</head><body>${html}</body></html>`;
}
