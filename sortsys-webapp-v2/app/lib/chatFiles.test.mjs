import assert from "node:assert/strict";
import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseFragment } from "parse5";
import {
  AssistantFileLink,
  AssistantMarkdown,
} from "../components/AssistantMarkdown.tsx";
import { projectFileLinkTarget } from "./projectFileLinks.ts";
import {
  isOnlyOfficeAttachment,
  isVideoAttachment,
  projectFilePreviewKind,
} from "./projectFilePreview.ts";

const currentUrl = "https://sortsys.example/llm/1abc?keep=chat#message";
const fileHref = "/projects/1abc/files?file=2def";
const target = { projectId: "1abc", fileId: "2def" };

function click(overrides = {}) {
  return {
    button: 0,
    defaultPrevented: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  };
}

for (const href of [
  fileHref,
  "https://sortsys.example/projects/1abc/files?file=2def",
  "//sortsys.example/projects/1abc/files?file=2def",
  "/projects/1abc/files/?file=2def#page=2",
  "/projects/%31abc/files?other=kept&file=2def",
  "../projects/1abc/files?file=2def",
]) {
  test(`opens the same-origin public file reference ${href}`, () => {
    assert.deepEqual(projectFileLinkTarget(href, currentUrl, click()), target);
  });
}

for (const overrides of [
  { button: 1 },
  { button: 2 },
  { ctrlKey: true },
  { metaKey: true },
  { shiftKey: true },
  { altKey: true },
  { defaultPrevented: true },
]) {
  test(`preserves native or already handled clicks ${JSON.stringify(overrides)}`, () => {
    assert.equal(
      projectFileLinkTarget(fileHref, currentUrl, click(overrides)),
      null,
    );
  });
}

for (const href of [
  undefined,
  "",
  "/projects/1abc",
  "/projects/1abc/files",
  "/projects/1abc/files?file=",
  "/projects/1abc/files?file=2def&file=3abc",
  "/projects/1abc/files/extra?file=2def",
  "/projects/1abc/files?file=../../secret",
  "/projects/1abc/files?file=not-a-public-id",
  "/projects/xyz/files?file=2def",
  "/projects/%2F1abc/files?file=2def",
  "/projects/%FF/files?file=2def",
  "/projects/1abc/files?file=vvvvvvvvvvvvvv",
  "/documents?q=test",
  "#message",
  "https://other.example/projects/1abc/files?file=2def",
  "http://sortsys.example/projects/1abc/files?file=2def",
  "https://sortsys.example:8443/projects/1abc/files?file=2def",
  "https://user:password@sortsys.example/projects/1abc/files?file=2def",
  "javascript:alert(1)",
  "data:text/html,example",
  "file:///projects/1abc/files?file=2def",
  "mailto:contact@example.test",
]) {
  test(`does not intercept unrelated, malformed or untrusted href ${href}`, () => {
    assert.equal(projectFileLinkTarget(href, currentUrl, click()), null);
  });
}

test("does not lose public IDs above JavaScript's safe integer range", () => {
  const href = "/projects/7vvvvvvvvvvvv/files?file=7vvvvvvvvvvvu";

  assert.deepEqual(projectFileLinkTarget(href, currentUrl, click()), {
    projectId: "7vvvvvvvvvvvv",
    fileId: "7vvvvvvvvvvvu",
  });
});

function anchorRenderer(onOpenFile) {
  return (props) => AssistantFileLink({ ...props, onOpenFile });
}

test("the actual Markdown anchor opens the modal and cancels route navigation", () => {
  const opened = [];
  const events = [];
  const previousWindow = globalThis.window;
  globalThis.window = { location: { href: currentUrl } };

  try {
    const anchor = anchorRenderer((value) => opened.push(value))({
      href: fileHref,
      children: "Plan.pdf",
    });
    anchor.props.onClick(
      click({
        preventDefault: () => events.push("prevented"),
        stopPropagation: () => events.push("stopped"),
      }),
    );

    assert.deepEqual(opened, [target]);
    assert.deepEqual(events, ["prevented", "stopped"]);
    assert.equal(anchor.props.href, fileHref);
    assert.equal(anchor.props.target, "_blank");
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  }
});

test("the actual Markdown anchor leaves modified and external links alone", () => {
  const previousWindow = globalThis.window;
  globalThis.window = { location: { href: currentUrl } };

  try {
    const render = anchorRenderer(() => assert.fail("Must not open a preview"));
    for (const [href, overrides] of [
      [fileHref, { ctrlKey: true }],
      [fileHref, { metaKey: true }],
      ["https://other.example/projects/1abc/files?file=2def", {}],
      ["/projects/1abc", {}],
    ]) {
      const anchor = render({ href, children: "Link" });
      anchor.props.onClick(
        click({
          ...overrides,
          preventDefault: () => assert.fail("Must preserve default navigation"),
          stopPropagation: () => assert.fail("Must preserve event propagation"),
        }),
      );
    }
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  }
});

function elements(root, tag) {
  return (root.childNodes ?? []).flatMap((child) => [
    ...(child.tagName === tag ? [child] : []),
    ...elements(child, tag),
  ]);
}

test("Markdown keeps file labels, hrefs, GFM and the existing HTML/image restrictions", () => {
  const html = renderToStaticMarkup(
    createElement(AssistantMarkdown, {
      content:
        `[**Plan.pdf**](${fileHref} "Source")\n\n` +
        "~~obsolete~~\n\n<script>alert(1)</script>\n\n![image](https://other.example/a.png)",
      onOpenFile: () => {},
    }),
  );
  const document = parseFragment(html);
  const links = elements(document, "a");
  assert.equal(links.length, 1);
  assert.equal(
    links[0].attrs.find((attr) => attr.name === "href").value,
    fileHref,
  );
  assert.equal(
    links[0].attrs.find((attr) => attr.name === "title").value,
    "Source",
  );
  assert.ok(
    links[0].attrs
      .find((attr) => attr.name === "rel")
      .value.includes("noopener"),
  );
  assert.equal(elements(document, "strong").length, 1);
  assert.equal(elements(document, "del").length, 1);
  assert.equal(elements(document, "script").length, 0);
  assert.equal(elements(document, "img").length, 0);
});

for (const [fileName, mimeType, kind, expected] of [
  ["Plan.PDF", "application/octet-stream", "file", "pdf"],
  ["download", "application/pdf; charset=binary", "file", "pdf"],
  ["Email.EML", "application/octet-stream", "file", "eml"],
  ["Mail.MSG", "application/vnd.ms-outlook", "file", "msg"],
  ["Plan.DWG", "image/vnd.dwg", "image", "dwg"],
  ["drawing", "application/x-acad", "image", "dwg"],
  ["Movie.MP4", "application/octet-stream", "file", "video"],
  ["stream", "video/webm", "file", "video"],
  ["Diagram.DRAWIO", "application/xml", "file", "drawio"],
  ["Calculation.XLSX", "application/octet-stream", "file", "office"],
  ["Report.DOCX", "application/octet-stream", "file", "office"],
  ["Photo.webp", "image/webp", "image", "image"],
  ["Archive.zip", "application/zip", "file", null],
]) {
  test(`selects the existing ${expected} viewer for ${fileName}`, () => {
    assert.equal(
      projectFilePreviewKind({ fileName, mimeType, kind }),
      expected,
    );
  });
}

test("shared office and video rules retain the project page's supported formats", () => {
  for (const extension of [
    "csv",
    "djvu",
    "doc",
    "docm",
    "docx",
    "dot",
    "dotm",
    "dotx",
    "dps",
    "dpt",
    "epub",
    "et",
    "ett",
    "fb2",
    "fodp",
    "fods",
    "fodt",
    "hml",
    "htm",
    "html",
    "hwp",
    "hwpx",
    "key",
    "md",
    "mht",
    "mhtml",
    "numbers",
    "odg",
    "odp",
    "ods",
    "odt",
    "otp",
    "ots",
    "ott",
    "oxps",
    "pages",
    "pot",
    "potm",
    "potx",
    "pps",
    "ppsm",
    "ppsx",
    "ppt",
    "pptm",
    "pptx",
    "rtf",
    "stw",
    "sxc",
    "sxi",
    "sxw",
    "txt",
    "vsdm",
    "vsdx",
    "vssm",
    "vssx",
    "vstm",
    "vstx",
    "wps",
    "wpt",
    "xls",
    "xlsb",
    "xlsm",
    "xlsx",
    "xlt",
    "xltm",
    "xltx",
    "xps",
  ]) {
    assert.equal(
      isOnlyOfficeAttachment({ fileName: `file.${extension}`, mimeType: "" }),
      true,
    );
  }

  for (const extension of [
    "3g2",
    "3gp",
    "avi",
    "m4v",
    "mkv",
    "mov",
    "mp4",
    "mpeg",
    "mpg",
    "ogv",
    "ogg",
    "webm",
  ]) {
    assert.equal(
      isVideoAttachment({ fileName: `file.${extension}`, mimeType: "" }),
      true,
    );
  }
});
