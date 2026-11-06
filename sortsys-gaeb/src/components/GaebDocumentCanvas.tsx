import { useImageRevision } from "../canvas/images";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useEventCallback } from "./useEventCallback";
import { flushSync } from "react-dom";
import ZoomIn from "@carbon/icons-react/es/ZoomIn";
import ZoomOut from "@carbon/icons-react/es/ZoomOut";
import FitToWidth from "@carbon/icons-react/es/FitToWidth";
import { EditorIconButton } from "./EditorIconButton";
import { useCanvasViewport } from "../canvas/useCanvasViewport";
import { canvasTileHeight, tileRaster } from "../canvas/raster";
import { measureText, fontMetricsRevision } from "../canvas/metrics";
import type { SharedFields, LiveSelection } from "../core/sharedFields";
import {
  extendSelection,
  selectionEnds,
  graphemeBoundary,
  wordBoundary,
  paragraphBoundary,
  macKeyboard,
  type TextRange,
} from "../canvas/keyboard";
import type { GaebDocument } from "../core/document";
import { errorText, text, type GaebLocale } from "../messages";
import { layoutGaebDocument, type GaebLayoutCache } from "../canvas/gaebLayout";
import {
  paintPage,
  hitOffset,
  fontString,
  type CanvasSelection,
} from "../canvas/render";
import {
  PAGE_WIDTH,
  PAGE_HEIGHT,
  type CanvasPage,
  type EditorField,
  type HitRegion,
  type Collaborator,
} from "../canvas/types";

export type RichSelection = {
  entryKey: string;
  index: number;
  start: number;
  end: number;
  direction?: "forward" | "backward" | "none";
};
export type CanvasFocus = {
  key: string;
  offset: number;
  end?: number;
  direction?: "forward" | "backward" | "none";
  sequence: number;
  revealOnly?: boolean;
};
type Props = {
  document: GaebDocument;
  reference?: GaebDocument;
  documentTitle?: string;
  projectTitle?: string;
  headingLabel?: string;
  locale: GaebLocale;
  editable: boolean;
  showFields: boolean;
  initialZoom?: number | null;
  onZoomChange?: (zoom: number | null) => void;
  drafts: Map<string, () => void>;
  revision: number;
  onDraftChange: () => void;
  onLocalTextEdit?: () => void;
  onChange: (operation: (document: GaebDocument) => string) => void;
  onEntry: (key: string) => void;
  onClearFocus: () => void;
  onSelection: (selection: RichSelection | null) => void;
  onEnter: (entryKey: string, index: number, offset: number) => void;
  onFormat: (
    property: "font-weight" | "font-style" | "text-decoration",
  ) => void;
  onError: (message: string) => void;
  focus: CanvasFocus | null;
  search: string;
  collaborators?: Collaborator[];
  onActiveField?: (key: string | null) => void;
  sharedFields?: SharedFields;
  onLiveSelection?: (selection: LiveSelection) => void;
  restoredDrafts?: Array<[string, string]>;
};

const NO_COLLABORATORS: Collaborator[] = [];

const Page = memo(function Page({
  page,
  allPages,
  showFields,
  hovered,
  setHovered,
  index,
  count,
  fieldSource,
  zoom,
  rasterZoom,
  pixelRatio,
  selection,
  caret,
  focused,
  activate,
  clearFocus,
  inputRef,
  printAll,
  locale,
  collaborators,
}: {
  page: CanvasPage;
  allPages: React.RefObject<CanvasPage[]>;
  showFields: boolean;
  hovered: string | undefined;
  setHovered: (key: string | undefined) => void;
  index: number;
  count: number;
  fieldSource: React.RefObject<Map<string, EditorField>>;
  zoom: number;
  rasterZoom: number;
  pixelRatio: number;
  selection: CanvasSelection | null;
  caret: boolean;
  focused: boolean;
  activate: (
    key: string,
    start: number,
    end?: number,
    reveal?: boolean,
    direction?: "forward" | "backward" | "none",
    line?: number,
  ) => void;
  clearFocus: () => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  printAll: boolean;
  locale: GaebLocale;
  collaborators: Collaborator[];
}) {
  const fields = useMemo(
    () =>
      new Map(page.fields.map((key) => [key, fieldSource.current.get(key)!])),
    [page, fieldSource],
  );
  const element = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const paintedCanvas = useRef<HTMLCanvasElement | null>(null);
  const pointer = useRef<{ id?: number; type: string }>({ type: "mouse" });
  const drag = useRef<{
    key: string;
    anchor: number;
    anchorEnd: number;
    granularity: "character" | "word" | "paragraph";
    x: number;
    y: number;
    frame?: number;
  } | null>(null);
  useEffect(
    () => () => {
      if (drag.current?.frame) cancelAnimationFrame(drag.current.frame);
    },
    [],
  );
  const [visible, setVisible] = useState(index === 0);
  const needed = printAll || visible;
  const raster = tileRaster(
    page.top ?? index * PAGE_HEIGHT,
    page.height ?? PAGE_HEIGHT,
    pixelRatio,
    zoom,
  );
  const paintRaster = printAll
    ? tileRaster(
        page.top ?? index * PAGE_HEIGHT,
        page.height ?? PAGE_HEIGHT,
        pixelRatio,
        1,
      )
    : raster;
  useEffect(() => {
    if (!element.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(!!entry?.isIntersecting),
      { rootMargin: "400px" },
    );
    observer.observe(element.current);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const node = canvas.current,
      context = node?.getContext("2d");
    if (!node || !context || !needed) return;
    // Reuse the existing bitmap during a zoom gesture. CSS scales it cheaply;
    // rerasterize once the gesture settles, at the final display resolution.
    if (!printAll && zoom !== rasterZoom && paintedCanvas.current === node)
      return;
    const ratio = paintRaster.scale;
    const width = Math.ceil(PAGE_WIDTH * ratio);
    const height = paintRaster.height;
    if (node.width !== width) node.width = width;
    if (node.height !== height) node.height = height;
    context.setTransform(
      ratio,
      0,
      0,
      ratio,
      0,
      paintRaster.offset -
        (page.painting ? (page.top ?? index * PAGE_HEIGHT) * ratio : 0),
    );
    paintPage(
      context,
      page,
      index,
      count,
      printAll ? null : selection,
      !printAll && caret && focused,
      printAll ? [] : collaborators,
      printAll ? undefined : { fields, hovered, showFields },
    );
    paintedCanvas.current = node;
  }, [
    needed,
    page,
    index,
    count,
    selection,
    caret,
    focused,
    printAll,
    collaborators,
    fields,
    hovered,
    showFields,
    zoom,
    rasterZoom,
    pixelRatio,
  ]);
  const hit = (event: { clientX: number; clientY: number }, key?: string) => {
    const viewport = element.current?.closest(".gaeb-document-scroll");
    const context = canvas.current?.getContext("2d");
    if (!viewport || !context) return null;
    const candidates = (key ? allPages.current : [page])
      .flatMap((part, partIndex) => {
        const tile = key
          ? viewport.querySelector<HTMLElement>(`[data-page="${partIndex}"]`)
          : element.current;
        if (!tile) return [];
        const bounds = tile.getBoundingClientRect();
        const x = (event.clientX - bounds.left) / zoom,
          y =
            (event.clientY - bounds.top) / zoom -
            tileRaster(
              part.top ?? partIndex * PAGE_HEIGHT,
              part.height ?? PAGE_HEIGHT,
              pixelRatio,
              zoom,
            ).logicalOffset;
        return part.regions
          .filter((region) =>
            key
              ? region.key === key
              : x >= region.x - 4 &&
                x <= region.x + region.width + 8 &&
                y >= region.y - 3 &&
                y <= region.y + region.height + 3,
          )
          .map((region) => ({
            region,
            x,
            line: (part.top ?? partIndex * PAGE_HEIGHT) + region.y,
            distance:
              Math.max(region.y - y, y - region.y - region.height, 0) * 10000 +
              Math.max(region.x - x, x - region.x - region.width, 0),
          }));
      })
      .sort((a, b) => a.distance - b.distance);
    const target = candidates[0];
    return target
      ? {
          region: target.region,
          line: target.line,
          offset: hitOffset(context, target.region, target.x),
        }
      : null;
  };
  const rangeAt = (
    field: EditorField,
    offset: number,
    granularity: "character" | "word" | "paragraph",
  ) => {
    if (granularity === "paragraph") {
      const start =
        offset === 0 ? 0 : field.value.lastIndexOf("\n", offset - 1) + 1;
      const newline = field.value.indexOf("\n", offset);
      return { start, end: newline < 0 ? field.value.length : newline + 1 };
    }
    if (granularity === "word") {
      const word = [
        ...new Intl.Segmenter(undefined, { granularity: "word" }).segment(
          field.value,
        ),
      ].find(
        (word) =>
          word.index <= offset &&
          word.index + word.segment.length >= offset &&
          word.isWordLike,
      );
      return {
        start: field.multiline && word ? word.index : 0,
        end:
          field.multiline && word
            ? word.index + word.segment.length
            : field.value.length,
      };
    }
    return { start: offset, end: offset };
  };
  const updateDrag = () => {
    const value = drag.current;
    if (!value) return;
    const target = hit({ clientX: value.x, clientY: value.y }, value.key);
    const field = fields.get(value.key);
    if (!target || !field) return;
    const range = rangeAt(field, target.offset, value.granularity);
    const backward = target.offset < value.anchor;
    activate(
      value.key,
      backward ? range.start : value.anchor,
      backward ? value.anchorEnd : Math.max(value.anchorEnd, range.end),
      false,
      backward ? "backward" : "forward",
      target.line,
    );
  };
  const stopDrag = () => {
    if (drag.current?.frame) cancelAnimationFrame(drag.current.frame);
    drag.current = null;
  };
  const scrollDrag = () => {
    const value = drag.current,
      viewport = element.current?.closest(".gaeb-document-scroll");
    if (!value || !viewport) return;
    const bounds = viewport.getBoundingClientRect();
    const speed =
      value.y < bounds.top + 28
        ? -Math.min(18, (bounds.top + 28 - value.y) / 2)
        : value.y > bounds.bottom - 28
          ? Math.min(18, (value.y - bounds.bottom + 28) / 2)
          : 0;
    if (speed) {
      viewport.scrollTop += speed;
      updateDrag();
    }
    value.frame = requestAnimationFrame(scrollDrag);
  };
  const beginSelection = (
    event: {
      clientX: number;
      clientY: number;
      shiftKey: boolean;
      currentTarget: HTMLCanvasElement;
    },
    clicks: number,
    pointerId?: number,
  ) => {
    stopDrag();
    const target = hit(event);
    const field = target && fields.get(target.region.key);
    if (!target || !field) {
      clearFocus();
      return;
    }
    const granularity =
      field.multiline && clicks >= 3
        ? "paragraph"
        : clicks >= 2
          ? "word"
          : "character";
    const range = rangeAt(field, target.offset, granularity);
    const anchor =
      granularity === "character" &&
      event.shiftKey &&
      selection?.key === field.key
        ? inputRef.current?.selectionDirection === "backward"
          ? selection.end
          : selection.start
        : range.start;
    const anchorEnd = granularity === "character" ? anchor : range.end;
    activate(
      field.key,
      Math.min(anchor, range.start),
      Math.max(anchorEnd, range.end),
      false,
      range.start < anchor ? "backward" : "forward",
      target.line,
    );
    drag.current = {
      key: field.key,
      anchor,
      anchorEnd,
      granularity,
      x: event.clientX,
      y: event.clientY,
    };
    if (pointerId !== undefined)
      event.currentTarget.setPointerCapture(pointerId);
    scrollDrag();
  };
  return (
    <article
      ref={element}
      className="gaeb-canvas-tile"
      aria-label={`${text(locale, "Dokumentabschnitt", "Document section")} ${index + 1}`}
      data-page={index}
      style={{
        width: PAGE_WIDTH * zoom,
        height: raster.cssHeight,
      }}
    >
      {needed && (
        <>
          <canvas
            ref={canvas}
            aria-hidden="true"
            style={{
              width: PAGE_WIDTH * zoom,
              height: raster.cssHeight,
            }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              pointer.current = {
                id: event.pointerId,
                type: event.pointerType,
              };
              if (event.pointerType === "touch")
                beginSelection(event, 1, event.pointerId);
            }}
            onMouseDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              // Touch has already placed the caret. Its compatibility mouse
              // event must not move focus away from the native input.
              if (pointer.current.type === "touch") return;
              // Mouse-down carries the platform's native click count. Apply the
              // final word/paragraph range before any frame can paint a caret.
              beginSelection(event, event.detail, pointer.current.id);
            }}
            onPointerMove={(event) => {
              if (drag.current) {
                drag.current.x = event.clientX;
                drag.current.y = event.clientY;
                updateDrag();
                return;
              }
              const target = hit(event);
              const key = target ? target.region.key : undefined;
              setHovered(key);
              event.currentTarget.style.cursor = key ? "text" : "default";
            }}
            onPointerLeave={() => {
              if (!drag.current) setHovered(undefined);
            }}
            onPointerUp={(event) => {
              stopDrag();
              pointer.current.id = undefined;
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={stopDrag}
            onLostPointerCapture={stopDrag}
          />
          <div
            className="gaeb-input-layer"
            style={{
              transform: `scale(${zoom})`,
              top: raster.cssOffset,
              height: page.height ?? PAGE_HEIGHT,
            }}
          >
            <div className="sr-only">
              {page.commands
                .filter(
                  (command) =>
                    command.kind === "text" &&
                    !command.field &&
                    command.y >= 0 &&
                    command.y < (page.height ?? PAGE_HEIGHT),
                )
                .map((command, i) => (
                  <span key={i}>
                    {command.kind === "text" ? command.text : ""}{" "}
                  </span>
                ))}
            </div>
            {page.fields.map((key) => {
              const field = fields.get(key)!,
                region = page.regions.find((region) => region.key === key)!;
              // Semantic mirrors never paint the document. Canvas remains its only
              // visible surface; keyboard/AT users can activate the same hit targets.
              return (
                <button
                  key={key}
                  type="button"
                  className="gaeb-canvas-field"
                  data-gaeb-field={key}
                  aria-label={field.label}
                  aria-description={field.value}
                  disabled={!field.editable}
                  tabIndex={-1}
                  onFocus={() =>
                    activate(key, 0, field.multiline ? 0 : field.value.length)
                  }
                  style={{
                    left: region.x,
                    top: region.y,
                    width: Math.max(40, region.width),
                    height: Math.max(24, region.height),
                  }}
                  onClick={() =>
                    activate(key, 0, field.multiline ? 0 : field.value.length)
                  }
                >
                  {field.value}
                </button>
              );
            })}
          </div>
        </>
      )}
    </article>
  );
});

export function GaebDocumentCanvas(props: Props) {
  const { document: model, locale, editable, drafts, revision } = props;
  const values = useRef(new Map<string, string>()).current;
  const restored = useRef<Props["restoredDrafts"]>(undefined);
  const input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const [selection, setSelection] = useState<CanvasSelection | null>(null);
  const activeKey = useRef<string | null>(null);
  const currentSelection = useRef<CanvasSelection | null>(null);
  const preferredX = useRef<number | null>(null);
  const activating = useRef(false);
  const tabDirection = useRef<-1 | 1 | null>(null);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      tabDirection.current =
        event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey
          ? event.shiftKey
            ? -1
            : 1
          : null;
    };
    const pointer = () => {
      tabDirection.current = null;
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("pointerdown", pointer, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("pointerdown", pointer, true);
    };
  }, []);
  const [focused, setFocused] = useState(false);
  const navigationKeys = useRef(new Set<string>()).current;
  const [navigating, setNavigating] = useState(false);
  const [caret, setCaret] = useState(true);
  useLayoutEffect(() => {
    setCaret(true);
    if (!focused || !selection || navigating) return;
    const interval = setInterval(() => setCaret((value) => !value), 550);
    return () => clearInterval(interval);
  }, [focused, selection, navigating]);
  const [printAll, setPrintAll] = useState(false);
  const { container, zoom, pixelRatio, changeZoom, fitWidth } =
    useCanvasViewport(props.initialZoom ?? null, props.onZoomChange);
  const [rasterZoom, setRasterZoom] = useState(zoom);
  useEffect(() => {
    const timer = setTimeout(() => setRasterZoom(zoom), 160);
    return () => clearTimeout(timer);
  }, [zoom]);
  const showFields = props.showFields;
  const [hovered, setHovered] = useState<string>();
  useEffect(() => {
    const before = () => flushSync(() => setPrintAll(true));
    const after = () => setPrintAll(false);
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
    };
  }, []);
  const fonts = fontMetricsRevision();
  const images = useImageRevision();
  const layoutCache = useMemo<GaebLayoutCache>(
    () => new Map(),
    [model, props.reference, locale, editable, pixelRatio, fonts, images],
  );
  const layout = useMemo(() => {
    if (typeof window === "undefined") return null;
    const context = window.document.createElement("canvas").getContext("2d");
    if (!context) return null;
    return layoutGaebDocument(model, context, {
      locale,
      editable,
      reference: props.reference,
      documentTitle: props.documentTitle,
      projectTitle: props.projectTitle,
      headingLabel: props.headingLabel,
      drafts: values,
      change: props.onChange,
      enter: props.onEnter,
      tileHeight: canvasTileHeight(pixelRatio),
      cache: layoutCache,
    });
  }, [
    model,
    props.reference,
    props.documentTitle,
    props.projectTitle,
    props.headingLabel,
    locale,
    editable,
    revision,
    pixelRatio,
    layoutCache,
  ]);
  const active = selection ? layout?.fields.get(selection.key) : undefined;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const allPages = useRef<CanvasPage[]>([]);
  allPages.current = layout?.pages ?? [];
  const fieldSource = useRef(new Map<string, EditorField>());
  if (layout) fieldSource.current = layout.fields;
  useEffect(() => {
    if (layout) props.sharedFields?.register(layout.fields);
  }, [layout, props.sharedFields]);
  useEffect(
    () =>
      props.sharedFields?.subscribe(
        ({ key, value, selection: remoteSelection }) => {
          const field = layoutRef.current?.fields.get(key);
          if (!field) return;
          values.set(key, value);
          if (field.editable)
            drafts.set(
              key,
              Object.assign(
                () => {
                  const current = layoutRef.current?.fields.get(key);
                  if (current) current.commit(value);
                  releaseDraftValue(key);
                  drafts.delete(key);
                },
                { value },
              ),
            );
          if (
            activeKey.current === key &&
            input.current &&
            !composing.current
          ) {
            const node = input.current;
            const start = remoteSelection?.start ?? node.selectionStart;
            const end = remoteSelection?.end ?? node.selectionEnd;
            node.value = value;
            node.setSelectionRange(
              Math.min(start, value.length),
              Math.min(end, value.length),
              remoteSelection?.direction ?? node.selectionDirection,
            );
            selectInput(node);
          }
          props.onDraftChange();
        },
      ),
    [props.sharedFields],
  );
  useLayoutEffect(() => {
    if (
      !editable ||
      !props.restoredDrafts?.length ||
      restored.current === props.restoredDrafts
    )
      return;
    restored.current = props.restoredDrafts;
    for (const [key, value] of props.restoredDrafts) {
      const field = layoutRef.current?.fields.get(key);
      if (!field?.editable) continue;
      values.set(key, value);
      drafts.set(
        key,
        Object.assign(
          () => {
            field.commit(value);
            releaseDraftValue(key);
            drafts.delete(key);
          },
          { value },
        ),
      );
      const node = input.current;
      if (activeKey.current === key && node) {
        const start = node.selectionStart,
          end = node.selectionEnd,
          direction = node.selectionDirection;
        node.value = value;
        node.setSelectionRange(
          Math.min(start, value.length),
          Math.min(end, value.length),
          direction,
        );
      }
    }
    props.onDraftChange();
  }, [props.restoredDrafts, editable]);
  const reportSelection = (next: CanvasSelection, field: EditorField) => {
    props.onActiveField?.(field.key);
    props.onLiveSelection?.({
      field: field.key,
      start: next.start,
      end: next.end,
      direction: next.direction,
    });
    currentSelection.current = next;
    setSelection(next);
    props.onSelection(
      field.editable && field.entryKey && field.richIndex !== undefined
        ? {
            entryKey: field.entryKey,
            index: field.richIndex,
            start: next.start,
            end: next.end,
            direction: next.direction,
          }
        : null,
    );
  };
  const releaseDraftValue = (key: string) => {
    const number =
      /(?::measure:[^:]+:(?:count|a|b|c|factor)|:(?:Qty|UP))$/.test(key);
    if (
      number &&
      activeKey.current === key &&
      window.document.activeElement === input.current
    )
      return;
    values.delete(key);
  };
  const commit = (key: string | undefined) => {
    if (!key) return true;
    try {
      drafts.get(key)?.();
      values.delete(key);
      props.onDraftChange();
      return true;
    } catch (failure) {
      props.onError(errorText(locale, failure));
      return false;
    }
  };
  const activate = (
    key: string,
    start: number,
    end = start,
    reveal = true,
    direction: "forward" | "backward" | "none" = "none",
    line?: number,
    focusInput = true,
  ) => {
    const field = layoutRef.current?.fields.get(key);
    if (!field) return;
    if (activeKey.current !== key && !commit(activeKey.current ?? undefined))
      return;
    activeKey.current = key;
    if (field.entryKey) props.onEntry(field.entryKey);
    preferredX.current = null;
    reportSelection({ key, start, end, direction, line }, field);
    if (input.current) {
      input.current.value = values.get(key) ?? field.value;
      input.current.readOnly = !field.editable;
      activating.current = true;
      if (focusInput) input.current.focus({ preventScroll: true });
      activating.current = false;
      input.current.setSelectionRange(start, end, direction);
      setFocused(focusInput);
    }
    if (!reveal) return;
    requestAnimationFrame(() => {
      const pageIndex = layout!.pages.findIndex((page) =>
        page.regions.some(
          (region) =>
            region.key === key &&
            region.from <= (direction === "backward" ? start : end) &&
            region.to >= (direction === "backward" ? start : end) &&
            (line === undefined ||
              Math.abs((page.top ?? 0) + region.y - line) < 1),
        ),
      );
      const page = container.current?.querySelector<HTMLElement>(
        `[data-page="${pageIndex}"]`,
      );
      const region = layout!.pages[pageIndex]?.regions.find(
        (region) =>
          region.key === key &&
          region.from <= (direction === "backward" ? start : end) &&
          region.to >= (direction === "backward" ? start : end) &&
          (line === undefined ||
            Math.abs((layout!.pages[pageIndex].top ?? 0) + region.y - line) <
              1),
      );
      const viewport = container.current;
      if (page && region && viewport) {
        const bounds = viewport.getBoundingClientRect(),
          tile = page.getBoundingClientRect();
        const raster = tileRaster(
          layout!.pages[pageIndex].top ?? 0,
          layout!.pages[pageIndex].height ?? PAGE_HEIGHT,
          pixelRatio,
          zoom,
        );
        const top = tile.top + region.y * zoom + raster.cssOffset,
          bottom = top + region.height * zoom;
        if (top < bounds.top + 12) viewport.scrollTop += top - bounds.top - 12;
        else if (bottom > bounds.bottom - 12)
          viewport.scrollTop += bottom - bounds.bottom + 12;
        const left = tile.left + region.x * zoom,
          right = left + region.width * zoom;
        if (left < bounds.left + 12)
          viewport.scrollLeft += left - bounds.left - 12;
        else if (right > bounds.right - 12)
          viewport.scrollLeft += right - bounds.right + 12;
      }
    });
  };
  useEffect(() => {
    if (props.focus && layout?.fields.has(props.focus.key)) {
      const field = layout.fields.get(props.focus.key)!;
      activate(
        props.focus.key,
        props.focus.offset,
        props.focus.end ??
          (!field.multiline && props.focus.offset === 0
            ? field.value.length
            : field.value === "…"
              ? 1
              : props.focus.offset),
        true,
        props.focus.direction,
        undefined,
        !props.focus.revealOnly,
      );
    } else if (props.focus?.key === "") {
      input.current?.blur();
      setSelection(null);
      activeKey.current = null;
      currentSelection.current = null;
      preferredX.current = null;
      setFocused(false);
      setHovered(undefined);
      navigationKeys.clear();
      setNavigating(false);
      props.onSelection(null);
      props.onActiveField?.(null);
      props.onLiveSelection?.({ field: null });
    }
  }, [props.focus?.sequence]);
  useEffect(() => {
    const field = activeKey.current
      ? layoutRef.current?.fields.get(activeKey.current)
      : undefined;
    const node = input.current;
    if (
      field &&
      node &&
      !values.has(field.key) &&
      !composing.current &&
      node.value !== field.value
    ) {
      const start = node.selectionStart,
        end = node.selectionEnd,
        direction = node.selectionDirection;
      node.value = field.value;
      node.setSelectionRange(
        Math.min(start, field.value.length),
        Math.min(end, field.value.length),
        direction,
      );
    }
  }, [model]);
  useLayoutEffect(() => {
    const viewport = container.current,
      node = input.current;
    if (!viewport || !node || !selection || !layout) return;
    const pageIndex = layout.pages.findIndex((page) =>
      page.regions.some(
        (region) =>
          region.key === selection.key &&
          region.from <=
            (selection.direction === "backward"
              ? selection.start
              : selection.end) &&
          region.to >=
            (selection.direction === "backward"
              ? selection.start
              : selection.end) &&
          (selection.line === undefined ||
            Math.abs((page.top ?? 0) + region.y - selection.line) < 1),
      ),
    );
    const region = layout.pages[pageIndex]?.regions.find(
      (region) =>
        region.key === selection.key &&
        region.from <=
          (selection.direction === "backward"
            ? selection.start
            : selection.end) &&
        region.to >=
          (selection.direction === "backward"
            ? selection.start
            : selection.end) &&
        (selection.line === undefined ||
          Math.abs(
            (layout.pages[pageIndex].top ?? 0) + region.y - selection.line,
          ) < 1),
    );
    const page = viewport.querySelector<HTMLElement>(
        `[data-page="${pageIndex}"]`,
      ),
      workspace = viewport.parentElement;
    if (!region || !page || !workspace) return;
    const measurement = window.document
      .createElement("canvas")
      .getContext("2d");
    if (!measurement) return;
    measurement.font = fontString(region.font);
    const x =
      (region.textX ?? region.x) +
      measurement.measureText(
        region.text.slice(
          0,
          (selection.direction === "backward"
            ? selection.start
            : selection.end) - region.from,
        ),
      ).width;
    const bounds = workspace.getBoundingClientRect(),
      paper = page.getBoundingClientRect();
    node.style.left = `${Math.max(2, Math.min(bounds.width - 8, paper.left - bounds.left + x * zoom))}px`;
    node.style.top = `${Math.max(38, Math.min(bounds.height - 28, paper.top - bounds.top + region.y * zoom + tileRaster(layout.pages[pageIndex].top ?? 0, layout.pages[pageIndex].height ?? PAGE_HEIGHT, pixelRatio, zoom).cssOffset))}px`;
  }, [layout, selection, zoom]);
  const activatePage = useEventCallback(activate);
  const clearPageFocus = useEventCallback(props.onClearFocus);
  useEffect(() => {
    if (!props.search || !layout) return;
    const match = model.entries.find((entry) =>
      `${entry.oz} ${entry.title}`
        .toLocaleLowerCase()
        .includes(props.search.toLocaleLowerCase()),
    );
    if (!match) return;
    const pageIndex = layout.pages.findIndex((page) =>
      page.fields.some((key) => key.startsWith(match.key + ":")),
    );
    container.current
      ?.querySelector(`[data-page="${pageIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
    props.onEntry(match.key);
  }, [props.search]);
  if (!layout)
    return (
      <p role="alert">
        {text(
          locale,
          "Dieser Browser unterstützt die Dokumentdarstellung nicht.",
          "This browser does not support document rendering.",
        )}
      </p>
    );
  const selectInput = (node: HTMLTextAreaElement) => {
    const field = activeKey.current
      ? layoutRef.current?.fields.get(activeKey.current)
      : undefined;
    if (field)
      reportSelection(
        {
          key: field.key,
          start: node.selectionStart,
          end: node.selectionEnd,
          direction: node.selectionDirection,
          line:
            currentSelection.current?.key === field.key &&
            currentSelection.current.start === node.selectionStart &&
            currentSelection.current.end === node.selectionEnd
              ? currentSelection.current.line
              : undefined,
        },
        field,
      );
  };
  const updateDraft = (
    field: EditorField,
    value: string,
    node: HTMLTextAreaElement,
  ) => {
    if (!field.editable) return;
    if (field.multiline || field.key.startsWith("meta:"))
      props.onLocalTextEdit?.();
    preferredX.current = null;
    props.sharedFields?.edit(
      field.key,
      values.get(field.key) ?? field.value,
      value,
    );
    values.set(field.key, value);
    drafts.set(
      field.key,
      Object.assign(
        () => {
          field.commit(value);
          releaseDraftValue(field.key);
          drafts.delete(field.key);
        },
        { value },
      ),
    );
    props.onDraftChange();
    selectInput(node);
  };
  const replaceSelection = (replacement: string) => {
    const node = input.current,
      field = activeKey.current
        ? layoutRef.current?.fields.get(activeKey.current)
        : undefined;
    if (!node || !field?.editable) return;
    const start = node.selectionStart,
      end = node.selectionEnd;
    node.value =
      node.value.slice(0, start) + replacement + node.value.slice(end);
    node.setSelectionRange(
      start + replacement.length,
      start + replacement.length,
    );
    updateDraft(field, node.value, node);
  };
  const tab = (reverse: boolean) => {
    const all = [...layoutRef.current!.fields.values()];
    const ordered = all.some((field) => field.editable)
      ? all.filter((field) => field.editable)
      : all;
    const index = ordered.findIndex((field) => field.key === activeKey.current);
    const field = ordered[index];
    const node = input.current;
    if (field?.multiline && node) {
      const focus =
        node.selectionDirection === "backward"
          ? node.selectionStart
          : node.selectionEnd;
      const start =
        focus === 0 ? 0 : node.value.lastIndexOf("\n", focus - 1) + 1;
      const nextBreak = node.value.indexOf("\n", focus);
      const target = reverse
        ? start > 0
          ? start === 1
            ? 0
            : node.value.lastIndexOf("\n", start - 2) + 1
          : -1
        : nextBreak < 0
          ? -1
          : nextBreak + 1;
      if (target >= 0) {
        const end = node.value.indexOf("\n", target);
        node.setSelectionRange(target, end < 0 ? node.value.length : end);
        selectInput(node);
        return true;
      }
    }
    if (!commit(activeKey.current ?? undefined)) return true;
    const next = ordered[index + (reverse ? -1 : 1)];
    if (!next) return false;
    const value = values.get(next.key) ?? next.value;
    const offset = reverse && next.multiline ? value.lastIndexOf("\n") + 1 : 0;
    const paragraphEnd = value.indexOf("\n", offset);
    activate(
      next.key,
      offset,
      next.multiline
        ? paragraphEnd < 0
          ? value.length
          : paragraphEnd
        : value.length,
    );
    return true;
  };
  const keyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const node = event.currentTarget,
      field = activeKey.current
        ? layoutRef.current?.fields.get(activeKey.current)
        : undefined;
    if (!field || event.nativeEvent.isComposing) return;
    const primary = (event.ctrlKey || event.metaKey) && !event.altKey,
      mac = macKeyboard();
    const range: TextRange = {
      start: node.selectionStart,
      end: node.selectionEnd,
      direction: node.selectionDirection,
    };
    const { focus } = selectionEnds(range);
    if (
      event.key === "Tab" &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      if (tab(event.shiftKey)) {
        event.preventDefault();
        // React Aria's modal focus scope also processes Tab on document, even
        // when defaultPrevented. Internal field navigation consumes the event.
        event.stopPropagation();
      }
      return;
    }
    if (primary && event.key.toLowerCase() === "a") {
      event.preventDefault();
      node.select();
      selectInput(node);
      return;
    }
    if (
      primary &&
      ["b", "i", "u"].includes(event.key.toLowerCase()) &&
      field.editable &&
      field.richIndex !== undefined
    ) {
      event.preventDefault();
      selectInput(node);
      props.onFormat(
        event.key.toLowerCase() === "b"
          ? "font-weight"
          : event.key.toLowerCase() === "i"
            ? "font-style"
            : "text-decoration",
      );
      return;
    }
    if (event.key === "Enter" && !field.multiline) {
      event.preventDefault();
      tab(event.shiftKey);
      return;
    }
    if (event.altKey && !mac) return;
    const word = event.ctrlKey || (mac && event.altKey);
    const command = event.metaKey;
    const regions = layoutRef.current!.pages.flatMap((page, index) =>
      page.regions
        .filter((region) => region.key === field.key)
        .map((region) => ({
          region,
          y: (page.top ?? index * PAGE_HEIGHT) + region.y,
        })),
    );
    const candidates = regions.filter(
      ({ region }) => region.from <= focus && region.to >= focus,
    );
    const current =
      candidates.find(
        ({ y }) =>
          currentSelection.current?.line !== undefined &&
          Math.abs(y - currentSelection.current.line) < 1,
      ) ??
      candidates.find(({ region }) => region.from === focus) ??
      candidates.at(-1);
    const lineEdge = (end: boolean) => {
      if (!current) return end ? node.value.length : 0;
      const line = regions
        .filter(({ y }) => Math.abs(y - current.y) < 1)
        .map(({ region }) => region);
      return end
        ? Math.max(...line.map((region) => region.to))
        : Math.min(...line.map((region) => region.from));
    };
    const backwards =
      event.key === "ArrowLeft" ||
      event.key === "ArrowUp" ||
      event.key === "Home" ||
      event.key === "Backspace" ||
      event.key === "PageUp";
    const direction = backwards ? -1 : 1;
    let position: number | undefined, targetLine: number | undefined;
    if (event.key === "Home" || event.key === "End") {
      position = primary
        ? backwards
          ? 0
          : node.value.length
        : lineEdge(!backwards);
      if (!primary) targetLine = current?.y;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      if (command) targetLine = current?.y;
      position = command
        ? lineEdge(!backwards)
        : word
          ? wordBoundary(node.value, focus, direction, mac)
          : !event.shiftKey && range.start !== range.end
            ? backwards
              ? range.start
              : range.end
            : graphemeBoundary(node.value, focus, direction);
    } else if (
      ["ArrowUp", "ArrowDown", "PageUp", "PageDown"].includes(event.key)
    ) {
      const pageMove = event.key.startsWith("Page");
      if (pageMove && primary) return;
      if (command) position = backwards ? 0 : node.value.length;
      else if (word)
        position = paragraphBoundary(node.value, focus, direction, mac);
      else if (current) {
        const measure = window.document
          .createElement("canvas")
          .getContext("2d")!;
        measure.font = fontString(current.region.font);
        const x =
          preferredX.current ??
          (current.region.textX ?? current.region.x) +
            measureText(
              measure,
              current.region.text.slice(0, focus - current.region.from),
            ).width;
        const rows = regions.filter(({ y }) =>
          backwards ? y < current.y - 1 : y > current.y + 1,
        );
        const destination =
          current.y +
          (pageMove
            ? ((backwards ? -1 : 1) *
                (container.current?.clientHeight ?? 600)) /
              zoom
            : 0);
        const nearest = rows.reduce(
          (best, row) =>
            Math.abs(row.y - destination) < Math.abs(best - destination)
              ? row.y
              : best,
          backwards ? -Infinity : Infinity,
        );
        const row = rows
          .filter(({ y }) => Math.abs(y - nearest) < 1)
          .sort(
            (a, b) =>
              Math.max(a.region.x - x, x - a.region.x - a.region.width, 0) -
              Math.max(b.region.x - x, x - b.region.x - b.region.width, 0),
          )[0];
        targetLine = row?.y;
        position = row
          ? hitOffset(measure, row.region, x)
          : backwards
            ? 0
            : node.value.length;
        preferredX.current = x;
      }
    } else if (
      (event.key === "Backspace" || event.key === "Delete") &&
      field.editable
    ) {
      if (event.shiftKey && event.key === "Delete" && !word && !command) return;
      event.preventDefault();
      if (range.start !== range.end) {
        replaceSelection("");
        return;
      }
      position = command
        ? lineEdge(!backwards)
        : word
          ? wordBoundary(node.value, focus, direction, mac)
          : graphemeBoundary(node.value, focus, direction);
      if (position === focus) return;
      node.setSelectionRange(
        Math.min(focus, position),
        Math.max(focus, position),
      );
      replaceSelection("");
      return;
    }
    if (position !== undefined) {
      event.preventDefault();
      navigationKeys.add(event.key);
      setNavigating(true);
      const selected = extendSelection(range, position, event.shiftKey),
        x = preferredX.current;
      const vertical =
        (event.key === "ArrowUp" || event.key === "ArrowDown") &&
        !word &&
        !command;
      activate(
        field.key,
        selected.start,
        selected.end,
        true,
        selected.direction,
        targetLine,
      );
      if (vertical) preferredX.current = x;
    }
  };
  return (
    <div className="gaeb-document-workspace">
      <div
        className="gaeb-document-scroll"
        ref={container}
        role="region"
        aria-label={text(locale, "Dokument", "Document")}
      >
        <div
          className="gaeb-document-paper"
          style={{ width: PAGE_WIDTH * zoom }}
        >
          {layout.pages.map((page, index) => (
            <Page
              key={index}
              page={page}
              allPages={allPages}
              showFields={showFields}
              hovered={
                hovered && page.fields.includes(hovered) ? hovered : undefined
              }
              setHovered={setHovered}
              index={index}
              count={layout.pages.length}
              fieldSource={fieldSource}
              zoom={zoom}
              rasterZoom={rasterZoom}
              pixelRatio={pixelRatio}
              selection={
                selection && page.fields.includes(selection.key)
                  ? selection
                  : null
              }
              caret={
                !!selection &&
                page.fields.includes(selection.key) &&
                (navigating || caret)
              }
              focused={
                focused && !!selection && page.fields.includes(selection.key)
              }
              activate={activatePage}
              clearFocus={clearPageFocus}
              inputRef={input}
              printAll={printAll}
              locale={locale}
              collaborators={props.collaborators ?? NO_COLLABORATORS}
            />
          ))}
        </div>
        {/* One persistent native input handles IME, selection, clipboard and mobile
        keyboards. It survives pagination/reflow and never paints document text. */}
        <textarea
          ref={input}
          className="gaeb-canvas-input"
          aria-label={
            active?.label ?? text(locale, "Dokumenteingabe", "Document input")
          }
          aria-multiline={active?.multiline ?? true}
          readOnly={!active?.editable}
          tabIndex={0}
          defaultValue=""
          spellCheck={active?.multiline}
          onChange={(event) => {
            const field = activeKey.current
              ? layoutRef.current?.fields.get(activeKey.current)
              : undefined;
            if (field)
              updateDraft(
                field,
                event.currentTarget.value,
                event.currentTarget,
              );
          }}
          onCopy={(event) => {
            const node = event.currentTarget;
            if (node.selectionStart === node.selectionEnd) return;
            event.preventDefault();
            event.clipboardData.setData(
              "text/plain",
              node.value.slice(node.selectionStart, node.selectionEnd),
            );
          }}
          onCut={(event) => {
            const node = event.currentTarget;
            if (node.selectionStart === node.selectionEnd) return;
            event.preventDefault();
            event.clipboardData.setData(
              "text/plain",
              node.value.slice(node.selectionStart, node.selectionEnd),
            );
            replaceSelection("");
          }}
          onPaste={(event) => {
            event.preventDefault();
            if (!active?.editable) return;
            const value = event.clipboardData
              .getData("text/plain")
              .replace(/\r\n?/g, "\n");
            replaceSelection(
              active.multiline ? value : value.replace(/\n/g, " "),
            );
          }}
          onSelect={(event) => selectInput(event.currentTarget)}
          onFocus={(event) => {
            setFocused(true);
            if (activating.current) return;
            if (tabDirection.current || !activeKey.current) {
              const all = [...layoutRef.current!.fields.values()],
                fields = all.some((field) => field.editable)
                  ? all.filter((field) => field.editable)
                  : all;
              const reverse = tabDirection.current === -1;
              const target = reverse ? fields.at(-1) : fields[0];
              tabDirection.current = null;
              if (target) {
                const value = values.get(target.key) ?? target.value;
                const start =
                  reverse && target.multiline ? value.lastIndexOf("\n") + 1 : 0;
                const end = value.indexOf("\n", start);
                activate(
                  target.key,
                  start,
                  target.multiline
                    ? end < 0
                      ? value.length
                      : end
                    : value.length,
                );
              }
            }
          }}
          onBlur={() => {
            setFocused(false);
            navigationKeys.clear();
            setNavigating(false);
            commit(activeKey.current ?? undefined);
            props.onActiveField?.(null);
            props.onLiveSelection?.({ field: null });
          }}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={keyDown}
          onKeyUp={(event) => {
            if (navigationKeys.delete(event.key) && !navigationKeys.size)
              setNavigating(false);
          }}
        />
      </div>
      <div
        className="gaeb-document-zoom"
        role="group"
        aria-label={text(locale, "Dokumentansicht", "Document view")}
      >
        <EditorIconButton
          label={text(locale, "Verkleinern", "Zoom out")}
          icon={ZoomOut}
          onClick={() => changeZoom(zoom - 0.1)}
        />
        <label className="gaeb-zoom-value">
          <span className="sr-only">
            {text(locale, "Zoom in Prozent", "Zoom percentage")}
          </span>
          <input
            aria-label={text(locale, "Zoom in Prozent", "Zoom percentage")}
            inputMode="numeric"
            key={Math.round(zoom * 100)}
            defaultValue={Math.round(zoom * 100)}
            onBlur={(event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next) && next > 0) changeZoom(next / 100);
              else event.target.value = String(Math.round(zoom * 100));
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
          <span aria-hidden="true">%</span>
        </label>
        <EditorIconButton
          label={text(locale, "Vergrößern", "Zoom in")}
          icon={ZoomIn}
          onClick={() => changeZoom(zoom + 0.1)}
        />
        <EditorIconButton
          label={text(locale, "An Breite anpassen", "Fit to width")}
          icon={FitToWidth}
          onClick={fitWidth}
        />
      </div>
    </div>
  );
}
