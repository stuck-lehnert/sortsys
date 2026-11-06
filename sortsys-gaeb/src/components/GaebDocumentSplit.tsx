import {
  cloneElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import { text, type GaebLocale } from "../messages";

const MIN_WIDTH = 200;
const DEFAULT_WIDTH = 320;

export function GaebDocumentSplit({
  outline,
  children,
  locale,
  initialWidth,
  onWidthChange,
}: {
  outline?: ReactElement<{ id?: string }>;
  children: ReactNode;
  locale: GaebLocale;
  initialWidth: number;
  onWidthChange: (width: number) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; width: number; pointer: number } | null>(
    null,
  );
  const frame = useRef<number | undefined>(undefined);
  const target = useRef(DEFAULT_WIDTH);
  const [storedWidth, setWidth] = useState(initialWidth);
  useEffect(() => setWidth(initialWidth), [initialWidth]);
  const changed = useRef(onWidthChange);
  changed.current = onWidthChange;
  const [available, setAvailable] = useState(1200);
  const [resizing, setResizing] = useState(false);
  const id = useId();
  const panel = useMemo(
    () => outline && cloneElement(outline, { id }),
    [outline, id],
  );
  const max = Math.max(
    MIN_WIDTH,
    Math.min(600, available - 280, Math.floor(available * 0.6)),
  );
  const width = Math.min(storedWidth, max);
  const clamp = (value: number) =>
    Math.round(Math.max(MIN_WIDTH, Math.min(max, value)));
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setAvailable(entry.contentRect.width),
    );
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => changed.current(storedWidth), 250);
    return () => clearTimeout(timer);
  }, [storedWidth]);
  useEffect(
    () => () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    },
    [],
  );
  const finish = (cancel = false) => {
    if (frame.current !== undefined) {
      cancelAnimationFrame(frame.current);
      frame.current = undefined;
    }
    if (drag.current) {
      const current = drag.current;
      drag.current = null;
      const finalWidth = cancel ? current.width : target.current;
      setWidth(finalWidth);
      changed.current(finalWidth);
      if (handle.current?.hasPointerCapture(current.pointer))
        handle.current.releasePointerCapture(current.pointer);
    }
    drag.current = null;
    setResizing(false);
  };
  return (
    <div
      ref={container}
      className="gaeb-document-body"
      data-resizing={resizing || undefined}
      style={{ "--gaeb-outline-width": `${width}px` } as CSSProperties}
    >
      {panel}
      {outline && (
        <div
          ref={handle}
          className="gaeb-outline-resizer"
          role="separator"
          tabIndex={0}
          aria-label={text(locale, "Breite der Gliederung", "Outline width")}
          aria-description={text(
            locale,
            "Mit den Pfeiltasten anpassen. Doppelklick setzt die Breite zurück.",
            "Use arrow keys to resize. Double-click resets the width.",
          )}
          aria-orientation="vertical"
          aria-controls={id}
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={max}
          aria-valuenow={width}
          aria-valuetext={`${width} px`}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.focus({ preventScroll: true });
            drag.current = {
              x: event.clientX,
              width,
              pointer: event.pointerId,
            };
            target.current = width;
            setResizing(true);
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!drag.current) return;
            target.current = clamp(
              drag.current.width + event.clientX - drag.current.x,
            );
            if (frame.current === undefined)
              frame.current = requestAnimationFrame(() => {
                frame.current = undefined;
                setWidth(target.current);
              });
          }}
          onPointerUp={() => finish()}
          onPointerCancel={() => finish(true)}
          onLostPointerCapture={() => {
            if (drag.current) finish();
          }}
          onDoubleClick={() => {
            const next = clamp(DEFAULT_WIDTH);
            setWidth(next);
            changed.current(next);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && drag.current) {
              event.preventDefault();
              event.stopPropagation();
              finish(true);
            }
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
              return;
            event.preventDefault();
            const step = event.shiftKey ? 40 : 10;
            const next = clamp(
              event.key === "Home"
                ? MIN_WIDTH
                : event.key === "End"
                  ? max
                  : width + (event.key === "ArrowLeft" ? -step : step),
            );
            setWidth(next);
            changed.current(next);
          }}
        />
      )}
      {children}
    </div>
  );
}
