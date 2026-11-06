import type { CanvasPage, Font, HitRegion, Collaborator } from "./types";
import { PAGE_WIDTH, PAGE_HEIGHT } from "./types";
import { measureText } from "./metrics";

const visiblePaintings = new WeakMap<
  CanvasPage,
  { commands: CanvasPage["commands"]; regions: HitRegion[] }
>();
function visiblePainting(page: CanvasPage) {
  if (!page.painting) return page;
  let visible = visiblePaintings.get(page);
  if (!visible) {
    const top = page.top ?? 0,
      bottom = top + (page.height ?? PAGE_HEIGHT);
    visible = {
      commands: page.painting.commands.filter((command) => {
        const overhang = 128;
        const height =
          command.kind === "box" || command.kind === "image"
            ? command.height
            : overhang;
        return command.y + height >= top && command.y - overhang <= bottom;
      }),
      regions: page.painting.regions.filter(
        (region) =>
          region.y + Math.max(region.height, 128) >= top &&
          region.y - 128 <= bottom,
      ),
    };
    visiblePaintings.set(page, visible);
  }
  return visible;
}

export function fontString(font: Font): string {
  return `${font.italic ? "italic " : ""}${font.bold ? "600 " : ""}${font.size}px ${font.family}`;
}
/** Offset from Canvas' top text origin to the alphabetic baseline. */
export function baselineOffset(context: CanvasRenderingContext2D, font: Font) {
  context.save();
  context.font = fontString(font);
  context.textBaseline = "alphabetic";
  const alphabetic = measureText(context, "Hg").actualBoundingBoxAscent;
  context.textBaseline = "top";
  const top = measureText(context, "Hg").actualBoundingBoxAscent;
  context.restore();
  return alphabetic - top;
}
export type CanvasSelection = {
  key: string;
  start: number;
  end: number;
  direction?: "forward" | "backward" | "none";
  line?: number;
};

/** Paint around the glyph line, independently of the larger pointer target. */
function textLineBox(context: CanvasRenderingContext2D, region: HitRegion) {
  context.font = fontString(region.font);
  context.textBaseline = "top";
  const metrics = measureText(context, "Hg");
  const top = region.y - metrics.actualBoundingBoxAscent;
  const height =
    metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent;
  return { y: top - 3, height: height + 6 };
}

export function paintPage(
  context: CanvasRenderingContext2D,
  page: CanvasPage,
  index: number,
  count: number,
  selection: CanvasSelection | null,
  caretVisible: boolean,
  collaborators: Collaborator[] = [],
  editing?: {
    fields: Map<string, import("./types").EditorField>;
    hovered?: string;
    showFields: boolean;
  },
) {
  const { commands, regions } = visiblePainting(page);
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, context.canvas.width, context.canvas.height);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, context.canvas.width, context.canvas.height);
  context.restore();
  if (editing) {
    const lines = new Map<string, HitRegion>();
    for (const region of regions) {
      if (!editing.fields.get(region.key)?.editable) continue;
      const key = `${region.key}:${region.y}`;
      const previous = lines.get(key);
      if (previous)
        previous.width =
          Math.max(previous.x + previous.width, region.x + region.width) -
          previous.x;
      else lines.set(key, { ...region });
    }
    for (const region of lines.values()) {
      const active = selection?.key === region.key,
        hovered = editing.hovered === region.key;
      if (!editing.showFields && !active && !hovered) continue;
      const line = textLineBox(context, region);
      // Snap chrome in global device coordinates before subtracting the tile
      // origin. Fractional stroke coverage must not depend on the canvas cut.
      const matrix = context.getTransform();
      const left = Math.round((region.x - 3) * matrix.a) + matrix.e;
      const top = Math.round(line.y * matrix.d) + matrix.f;
      const right =
        Math.round((region.x + region.width + 3) * matrix.a) + matrix.e;
      const bottom = Math.round((line.y + line.height) * matrix.d) + matrix.f;
      const stroke = Math.max(1, Math.round((active ? 1.2 : 0.7) * matrix.a));
      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.fillStyle = active ? "#e7f0fd" : hovered ? "#edf4ff" : "#f3f6fb";
      context.beginPath();
      context.rect(
        left + stroke / 2,
        top + stroke / 2,
        right - left - stroke,
        bottom - top - stroke,
      );
      context.fill();
      context.strokeStyle = active
        ? "#2865b2"
        : hovered
          ? "#668dbe"
          : "#afbdcf";
      context.lineWidth = stroke;
      context.setLineDash(
        active || hovered
          ? []
          : [
              Math.max(1, Math.round(2 * matrix.a)),
              Math.max(1, Math.round(2 * matrix.a)),
            ],
      );
      context.stroke();
      context.restore();
    }
  }
  if (selection) {
    for (const region of regions.filter(
      (region) => region.key === selection.key,
    )) {
      context.font = fontString(region.font);
      const start = Math.max(region.from, selection.start),
        end = Math.min(region.to, selection.end);
      if (start < end) {
        const line = textLineBox(context, region);
        const left = measureText(
          context,
          region.text.slice(0, start - region.from),
        ).width;
        const width =
          measureText(context, region.text.slice(0, end - region.from)).width -
          left;
        const matrix = context.getTransform();
        const x = (region.textX ?? region.x) + left;
        const pixelLeft = Math.floor(x * matrix.a),
          pixelRight = Math.ceil((x + Math.max(1, width)) * matrix.a);
        const pixelTop = Math.floor((line.y + 2) * matrix.d),
          pixelBottom = Math.ceil((line.y + line.height - 2) * matrix.d);
        context.save();
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.fillStyle = "#0000ff";
        context.fillRect(
          pixelLeft + matrix.e,
          pixelTop + matrix.f,
          pixelRight - pixelLeft,
          pixelBottom - pixelTop,
        );
        context.restore();
      }
    }
  }
  for (const person of collaborators) {
    if (
      person.start === undefined ||
      person.end === undefined ||
      person.start === person.end
    )
      continue;
    for (const region of regions.filter(
      (region) => region.key === person.field,
    )) {
      const start = Math.max(region.from, Math.min(person.start, person.end));
      const end = Math.min(region.to, Math.max(person.start, person.end));
      if (start >= end) continue;
      context.font = fontString(region.font);
      const left = measureText(
        context,
        region.text.slice(0, start - region.from),
      ).width;
      const right = measureText(
        context,
        region.text.slice(0, end - region.from),
      ).width;
      const line = textLineBox(context, region);
      context.save();
      context.globalAlpha = 0.22;
      context.fillStyle = person.color;
      context.fillRect(
        (region.textX ?? region.x) + left,
        line.y + 2,
        Math.max(1, right - left),
        line.height - 4,
      );
      context.restore();
    }
  }
  for (const command of commands) {
    if (command.kind === "text") {
      context.font = fontString(command.font);
      context.textBaseline = "top";
      const draw = (color: string) => {
        context.fillStyle = color;
        context.fillText(command.text, command.x, command.y);
        if (command.font.underline) {
          const matrix = context.getTransform();
          const width = measureText(context, command.text).width;
          const stroke = Math.max(1, Math.round(0.8 * matrix.a));
          const y =
            Math.round(
              (command.y + baselineOffset(context, command.font) + 1) *
                matrix.d,
            ) +
            matrix.f +
            (stroke % 2) / 2;
          context.save();
          context.setTransform(1, 0, 0, 1, 0, 0);
          context.strokeStyle = color;
          context.lineWidth = stroke;
          context.beginPath();
          context.moveTo(Math.round(command.x * matrix.a) + matrix.e, y);
          context.lineTo(
            Math.round((command.x + width) * matrix.a) + matrix.e,
            y,
          );
          context.stroke();
          context.restore();
        }
      };
      const start = Math.max(command.from ?? 0, selection?.start ?? 0),
        end = Math.min(command.to ?? 0, selection?.end ?? 0);
      if (selection?.key === command.field && start < end) {
        const left =
          command.x +
          measureText(context, command.text.slice(0, start - command.from!))
            .width;
        const right =
          command.x +
          measureText(context, command.text.slice(0, end - command.from!))
            .width;
        // Clip the original glyphs rather than reshaping substrings: kerning,
        // ligatures, font styles and underlines keep their exact positions.
        context.save();
        context.beginPath();
        context.rect(
          0,
          command.y - command.font.size,
          left,
          command.font.size * 3,
        );
        context.rect(
          right,
          command.y - command.font.size,
          PAGE_WIDTH - right,
          command.font.size * 3,
        );
        context.clip();
        draw(command.font.color ?? "#202124");
        context.restore();
        context.save();
        context.beginPath();
        context.rect(
          left,
          command.y - command.font.size,
          right - left,
          command.font.size * 3,
        );
        context.clip();
        draw("#ffffff");
        context.restore();
      } else draw(command.font.color ?? "#202124");
    } else if (command.kind === "image") {
      if (command.resource.ready)
        context.drawImage(
          command.resource.image,
          command.x,
          command.y,
          command.width,
          command.height,
        );
      else {
        context.strokeStyle = "#d1d5db";
        context.strokeRect(command.x, command.y, command.width, command.height);
      }
    } else {
      context.strokeStyle = "#d1d5db";
      context.lineWidth = 0.7;
      if (command.kind === "box")
        context.strokeRect(command.x, command.y, command.width, command.height);
      else {
        context.beginPath();
        context.moveTo(command.x, command.y);
        context.lineTo(command.x + command.width, command.y);
        context.stroke();
      }
    }
  }
  for (const person of collaborators) {
    const offset = person.direction === "backward" ? person.start : person.end;
    const region = regions.find(
      (region) =>
        region.key === person.field &&
        (offset === undefined ||
          (region.from <= offset && region.to >= offset)),
    );
    if (!region) continue;
    const line = textLineBox(context, region);
    context.font = fontString(region.font);
    const x =
      (region.textX ?? region.x) +
      measureText(
        context,
        region.text.slice(
          0,
          Math.max(0, (offset ?? region.from) - region.from),
        ),
      ).width;
    context.strokeStyle = person.color;
    context.lineWidth = 1.6;
    context.beginPath();
    context.moveTo(x, line.y + 1);
    context.lineTo(x, line.y + line.height - 1);
    context.stroke();
    context.font = "10px Arial, sans-serif";
    const width = measureText(context, person.name).width + 8;
    context.fillStyle = person.color;
    const labelX = Math.min(x, PAGE_WIDTH - width - 4);
    context.fillRect(labelX, Math.max(0, line.y - 14), width, 14);
    context.fillStyle = "#fff";
    context.fillText(person.name, labelX + 4, Math.max(1, line.y - 12));
  }
  if (selection && caretVisible && selection.start === selection.end) {
    const region = regions.find(
      (region) =>
        region.key === selection.key &&
        region.from <= selection.start &&
        region.to >= selection.start &&
        (selection.line === undefined ||
          Math.abs(
            (page.painting ? 0 : (page.top ?? index * PAGE_HEIGHT)) +
              region.y -
              selection.line,
          ) < 1),
    );
    if (region) {
      const line = textLineBox(context, region);
      context.font = fontString(region.font);
      const x =
        (region.textX ?? region.x) +
        measureText(
          context,
          region.text.slice(0, selection.start - region.from),
        ).width;
      context.fillStyle = "#005fcc";
      context.fillRect(x, line.y + 2, 1.2, line.height - 4);
    }
  }
}

export function hitOffset(
  context: CanvasRenderingContext2D,
  region: HitRegion,
  x: number,
): number {
  context.font = fontString(region.font);
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let previous = 0;
  for (const segment of segmenter.segment(region.text)) {
    const next = segment.index + segment.segment.length;
    const left = measureText(context, region.text.slice(0, previous)).width;
    const right = measureText(context, region.text.slice(0, next)).width;
    if (x - (region.textX ?? region.x) < (left + right) / 2)
      return region.from + previous;
    previous = next;
  }
  return region.to;
}
