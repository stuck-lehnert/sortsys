// This is a small value grammar, not a general CSS parser. No URLs, escapes,
// variables, positioning, selectors or sender-provided stylesheets are accepted.
const COLOR = /^(?:#[a-f0-9]{3,4}|#[a-f0-9]{6}|#[a-f0-9]{8}|[a-z]{1,24}|rgba?\(\s*\d{1,3}%?\s*,\s*\d{1,3}%?\s*,\s*\d{1,3}%?(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\))$/i;
const LENGTH = /^(?:0|\d{1,4}(?:\.\d{1,3})?(?:px|pt|em|rem|%))$/i;
const SPACING = /^(?:0|\d{1,3}(?:\.\d{1,2})?(?:px|pt|em|rem|%))$/i;

function safeValue(property: string, value: string): boolean {
  if (/[\\@{}<>\x00-\x1f]/.test(value) || value.includes("/*")) return false;
  switch (property) {
    case "color": case "background-color": return COLOR.test(value);
    case "font-family": return /^[a-z][a-z0-9 ,"'\-]{0,160}$/i.test(value.replace(/^["']/, ""));
    case "font-size": return LENGTH.test(value);
    case "font-weight": return /^(?:normal|bold|[1-9]00)$/i.test(value);
    case "font-style": return /^(?:normal|italic|oblique)$/i.test(value);
    case "text-align": return /^(?:left|right|center|justify|start|end)$/i.test(value);
    case "vertical-align": return /^(?:top|middle|bottom|baseline)$/i.test(value);
    case "text-decoration": return /^(?:none|underline|line-through|underline line-through)$/i.test(value);
    case "line-height": return /^(?:normal|[1-3](?:\.\d{1,2})?)$/i.test(value) || LENGTH.test(value);
    case "white-space": return /^(?:normal|pre-wrap|pre-line)$/i.test(value);
    case "width": case "height": case "max-width": return value === "auto" || LENGTH.test(value);
    case "padding": case "margin": return value.split(/\s+/).length <= 4 && value.split(/\s+/).every(part => SPACING.test(part));
    case "padding-top": case "padding-bottom": case "padding-left": case "padding-right":
    case "margin-top": case "margin-bottom": case "margin-left": case "margin-right": return SPACING.test(value);
    case "border-collapse": return /^(?:collapse|separate)$/i.test(value);
    case "border-spacing": return value.split(/\s+/).length <= 2 && value.split(/\s+/).every(part => SPACING.test(part));
    case "border": case "border-top": case "border-bottom": case "border-left": case "border-right": {
      if (value === "0" || value === "none") return true;
      const match = /^(\d{1,2}(?:px|pt))\s+(solid|dashed|dotted|double)\s+(.+)$/i.exec(value);
      return !!match && COLOR.test(match[3]);
    }
    default: return false;
  }
}

export function safeEmailStyles(value: string): string {
  return value.slice(0, 4096).split(";").slice(0, 48).flatMap(declaration => {
    const colon = declaration.indexOf(":");
    if (colon < 0) return [];
    let property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim().replace(/\s*!important\s*$/i, "");
    if (property === "background") property = "background-color";
    return safeValue(property, value) ? [`${property}:${value}`] : [];
  }).join(";");
}
