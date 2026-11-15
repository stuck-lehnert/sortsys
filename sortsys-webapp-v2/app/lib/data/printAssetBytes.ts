import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { parseFragment, serialize, type DefaultTreeAdapterMap } from "parse5";
import { MAX_PRINT_ASSET_BYTES } from "./printTemplateData";

function raster(type: string, bytes: Uint8Array): boolean {
  const starts = (prefix: number[]) =>
    prefix.every((value, index) => bytes[index] === value);
  if (type === "image/png") return starts([137, 80, 78, 71, 13, 10, 26, 10]);
  if (type === "image/jpeg") return starts([255, 216, 255]);
  const header = new TextDecoder().decode(bytes.subarray(0, 12));
  if (type === "image/gif")
    return header.startsWith("GIF87a") || header.startsWith("GIF89a");
  if (type === "image/webp")
    return header.startsWith("RIFF") && header.slice(8) === "WEBP";
  return false;
}
function css(value: string) {
  const local = value.replace(/url\(\s*(['"]?)#[^\s'"()\\]+\1\s*\)/gi, "");
  if (/[\\@&]/.test(local)) throw new InvalidProtectedData();
  const allowed = new Set([
    "rgb",
    "rgba",
    "hsl",
    "hsla",
    "hwb",
    "lab",
    "lch",
    "oklab",
    "oklch",
    "color",
    "color-mix",
    "calc",
    "min",
    "max",
    "clamp",
    "var",
    "matrix",
    "matrix3d",
    "translate",
    "translatex",
    "translatey",
    "translate3d",
    "scale",
    "scalex",
    "scaley",
    "rotate",
    "rotatex",
    "rotatey",
    "rotatez",
    "skew",
    "skewx",
    "skewy",
    "not",
    "is",
    "where",
    "nth-child",
    "nth-of-type",
  ]);
  for (const match of local.matchAll(/([a-z_-][a-z0-9_-]*)\s*\(/gi))
    if (!allowed.has(match[1]!.toLowerCase())) throw new InvalidProtectedData();
}
function href(value: string) {
  if (/^#[^\s'"<>]+$/u.test(value)) return;
  const embedded =
    /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(
      value,
    );
  if (!embedded) throw new InvalidProtectedData();
  const raw = Uint8Array.from(atob(embedded[2]!), (char) => char.charCodeAt(0));
  try {
    if (!raster(embedded[1]!, raw)) throw new InvalidProtectedData();
  } finally {
    raw.fill(0);
  }
}
function staticSvg(bytes: Uint8Array) {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (
    /<!\s*(?:DOCTYPE|ENTITY)/i.test(source) ||
    /<\?(?!xml\s)/i.test(source) ||
    /<\?xml\s[^?]*encoding\s*=\s*['"](?!utf-?8['"]|us-ascii['"])/i.test(source)
  )
    throw new InvalidProtectedData();
  const tags = new Map(
    [
      "svg",
      "g",
      "defs",
      "symbol",
      "use",
      "path",
      "rect",
      "circle",
      "ellipse",
      "line",
      "polyline",
      "polygon",
      "text",
      "tspan",
      "textPath",
      "linearGradient",
      "radialGradient",
      "stop",
      "clipPath",
      "mask",
      "pattern",
      "marker",
      "filter",
      "feBlend",
      "feColorMatrix",
      "feComponentTransfer",
      "feComposite",
      "feConvolveMatrix",
      "feDiffuseLighting",
      "feDisplacementMap",
      "feDistantLight",
      "feDropShadow",
      "feFlood",
      "feFuncA",
      "feFuncB",
      "feFuncG",
      "feFuncR",
      "feGaussianBlur",
      "feImage",
      "feMerge",
      "feMergeNode",
      "feMorphology",
      "feOffset",
      "fePointLight",
      "feSpecularLighting",
      "feSpotLight",
      "feTile",
      "feTurbulence",
      "image",
      "title",
      "desc",
      "metadata",
      "style",
      "a",
      "view",
    ].map((tag) => [tag.toLowerCase(), tag]),
  );
  const root = parseFragment(source),
    metadata: DefaultTreeAdapterMap["element"][] = [];
  const nodes: {
    node: DefaultTreeAdapterMap["node"];
    depth: number;
    metadata: boolean;
  }[] = root.childNodes.map((node) => ({ node, depth: 0, metadata: false }));
  let count = 0,
    svg = 0;
  while (nodes.length) {
    const { node, depth, metadata: inMetadata } = nodes.pop()!;
    if (++count > 100000 || depth > 128) throw new InvalidProtectedData();
    if ("tagName" in node) {
      const tag = node.tagName.toLowerCase().split(":").at(-1)!;
      if (
        node.namespaceURI !== "http://www.w3.org/2000/svg" ||
        [
          "script",
          "handler",
          "listener",
          "foreignobject",
          "animate",
          "animatetransform",
          "animatemotion",
          "set",
          "discard",
        ].includes(tag) ||
        (!inMetadata && !tags.has(tag))
      )
        throw new InvalidProtectedData();
      if (depth === 0) {
        if (tag !== "svg") throw new InvalidProtectedData();
        svg++;
      }
      node.tagName = tags.get(tag) ?? node.tagName;
      for (const attr of node.attrs) {
        const name = attr.name.toLowerCase().split(":").at(-1)!;
        if (name.startsWith("on") || name === "base")
          throw new InvalidProtectedData();
        if (name === "href") href(attr.value);
        if (name === "style" || /url\s*\(|\\/i.test(attr.value))
          css(attr.value);
      }
      // The render copy has one known namespace. Original vendor metadata and
      // declarations remain in the encrypted file, never in the image DOM.
      const directHref = node.attrs.find(
        (attr) =>
          attr.name.toLowerCase() === "href" && !attr.prefix && !attr.namespace,
      );
      node.attrs = node.attrs.flatMap((attr) => {
        const name = attr.name.toLowerCase();
        if (
          attr.prefix === "xmlns" ||
          name === "xmlns" ||
          name.startsWith("xmlns:")
        )
          return [];
        const local = name.split(":").at(-1)!;
        if (local === "href")
          return directHref && attr !== directHref
            ? []
            : [{ name: "href", value: attr.value }];
        if (name.includes(":") && !name.startsWith("xml:")) return [];
        return [attr];
      });
      node.attrs = [
        ...new Map(
          node.attrs.map((attr) => [
            `${attr.namespace ?? ""}:${attr.prefix ?? ""}:${attr.name}`,
            attr,
          ]),
        ).values(),
      ];
      if (depth === 0)
        node.attrs.push({ name: "xmlns", value: "http://www.w3.org/2000/svg" });
      if (tag === "metadata") metadata.push(node);
      if (tag === "style")
        css(
          node.childNodes
            .map((child) => ("value" in child ? child.value : ""))
            .join(""),
        );
    } else if (depth === 0 && "value" in node && node.value.trim())
      throw new InvalidProtectedData();
    if ("childNodes" in node)
      for (const child of node.childNodes)
        nodes.push({
          node: child,
          depth: depth + 1,
          metadata:
            inMetadata || ("tagName" in node && node.tagName === "metadata"),
        });
  }
  if (svg !== 1) throw new InvalidProtectedData();
  for (const node of metadata) node.childNodes = [];
  return serialize(root);
}
export function renderPrintSvg(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!bytes.length || bytes.length > MAX_PRINT_ASSET_BYTES)
    throw new InvalidProtectedData();
  return new TextEncoder().encode(staticSvg(bytes));
}
/** The browser validates media before publication and again before decoding.
 * SVG is static: local fragment links and embedded raster images are allowed;
 * scripts, handlers, remote references, CSS imports and animations are rejected. */
export function validatePrintAssetBytes(type: string, bytes: Uint8Array) {
  if (!bytes.length || bytes.length > MAX_PRINT_ASSET_BYTES)
    throw new InvalidProtectedData();
  if (type === "image/svg+xml") {
    staticSvg(bytes);
    return;
  }
  if (type === "application/pdf") {
    if (new TextDecoder().decode(bytes.subarray(0, 1028)).includes("%PDF-"))
      return;
  } else if (raster(type, bytes)) return;
  throw new InvalidProtectedData();
}
