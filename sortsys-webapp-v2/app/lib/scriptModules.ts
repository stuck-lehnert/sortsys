export const scriptModuleExports = {
  "sortsys-client": ["client"],
  "sortsys-popups": ["requireConfirmation", "requireDangerConfirmation"],
  "sortsys-modal-forms": ["showModalForm"],
  "sortsys-log": ["log"],
  "sortsys-utils": [
    "escapeHtml", "urlEncode", "urlDecode",
    "toBase64", "fromBase64", "toBase64Url", "fromBase64Url",
    "utf8Decode", "utf8Encode",
    "sum", "mean", "median", "min", "max", "clamp", "round",
    "unique", "chunk", "range", "isBlank", "sleep",
  ],
} as const;

export type ScriptModuleName = keyof typeof scriptModuleExports;
export const scriptModuleNames = Object.keys(scriptModuleExports);

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function scriptModuleImportPattern() {
  const modules = scriptModuleNames.map(escapeRegExp).join("|");
  return new RegExp(`\\bimport\\s*\\(\\s*(['"])(${modules})\\1\\s*\\)`, "g");
}
