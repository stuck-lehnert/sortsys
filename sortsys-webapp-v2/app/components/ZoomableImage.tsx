import { Icons } from "~/lib/icons";
import { uiText } from "~/lib/i18n";
import { useCallback, useEffect, useRef, useState } from "react";

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const ZOOM_STEP = 1.35;

type ViewTransform = {
  scale: number;
  x: number;
  y: number;
};

type Point = {
  x: number;
  y: number;
};

type Gesture = {
  center: Point;
  distance: number;
  transform: ViewTransform;
};

function distanceBetween(first: Point, second: Point) {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function centerBetween(first: Point, second: Point): Point {
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
  };
}

function clampScale(scale: number) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function ZoomableImage(props: {
  src: string;
  alt: string;
  hasMultipleImages: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const transformRef = useRef<ViewTransform>({ scale: 1, x: 0, y: 0 });
  const pointersRef = useRef(new Map<number, Point>());
  const dragStartRef = useRef<{ point: Point; transform: ViewTransform } | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const [transform, setTransformState] = useState<ViewTransform>(transformRef.current);

  const constrain = useCallback((next: ViewTransform): ViewTransform => {
    const stage = stageRef.current;
    const image = imageRef.current;
    const scale = clampScale(next.scale);

    if (!stage || !image || scale === 1) {
      return { scale, x: 0, y: 0 };
    }

    // clientWidth/clientHeight are the image's untransformed, contained size.
    // This keeps an enlarged image from being dragged entirely out of view.
    const maxX = Math.max(0, (image.clientWidth * scale - stage.clientWidth) / 2);
    const maxY = Math.max(0, (image.clientHeight * scale - stage.clientHeight) / 2);

    return {
      scale,
      x: Math.min(maxX, Math.max(-maxX, next.x)),
      y: Math.min(maxY, Math.max(-maxY, next.y)),
    };
  }, []);

  const setTransform = useCallback((next: ViewTransform) => {
    const constrained = constrain(next);
    transformRef.current = constrained;
    setTransformState(constrained);
  }, [constrain]);

  const reset = useCallback(() => {
    setTransform({ scale: 1, x: 0, y: 0 });
  }, [setTransform]);

  const zoomAt = useCallback((scale: number, clientPoint?: Point) => {
    const stage = stageRef.current;
    const current = transformRef.current;
    if (!stage) return;

    const bounds = stage.getBoundingClientRect();
    const point = clientPoint ?? {
      x: bounds.left + bounds.width / 2,
      y: bounds.top + bounds.height / 2,
    };
    const center = {
      x: bounds.left + bounds.width / 2,
      y: bounds.top + bounds.height / 2,
    };
    const nextScale = clampScale(scale);

    setTransform({
      scale: nextScale,
      x: point.x - center.x - ((point.x - center.x - current.x) / current.scale) * nextScale,
      y: point.y - center.y - ((point.y - center.y - current.y) / current.scale) * nextScale,
    });
  }, [setTransform]);

  useEffect(() => {
    pointersRef.current.clear();
    dragStartRef.current = null;
    gestureRef.current = null;
    reset();
  }, [props.src, reset]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => setTransform(transformRef.current));
    observer.observe(stage);

    return () => observer.disconnect();
  }, [setTransform]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      if ((event.target as HTMLElement).closest("button")) return;

      const factor = Math.exp(-event.deltaY * 0.002);
      zoomAt(transformRef.current.scale * factor, { x: event.clientX, y: event.clientY });
    };

    stage.addEventListener("wheel", handleWheel, { passive: false });
    return () => stage.removeEventListener("wheel", handleWheel);
  }, [zoomAt]);

  const beginGesture = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;

    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...pointersRef.current.values()];

    if (points.length === 1) {
      dragStartRef.current = {
        point: points[0],
        transform: transformRef.current,
      };
    } else if (points.length === 2) {
      gestureRef.current = {
        center: centerBetween(points[0], points[1]),
        distance: distanceBetween(points[0], points[1]),
        transform: transformRef.current,
      };
      dragStartRef.current = null;
    }
  };

  const continueGesture = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return;

    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...pointersRef.current.values()];

    if (points.length === 1 && dragStartRef.current && transformRef.current.scale > 1) {
      const start = dragStartRef.current;
      setTransform({
        ...start.transform,
        x: start.transform.x + points[0].x - start.point.x,
        y: start.transform.y + points[0].y - start.point.y,
      });
      return;
    }

    if (points.length !== 2 || !gestureRef.current || !stageRef.current) return;

    const gesture = gestureRef.current;
    const currentCenter = centerBetween(points[0], points[1]);
    const nextScale = clampScale(
      gesture.transform.scale * distanceBetween(points[0], points[1]) / Math.max(gesture.distance, 1),
    );
    const bounds = stageRef.current.getBoundingClientRect();
    const stageCenter = {
      x: bounds.left + bounds.width / 2,
      y: bounds.top + bounds.height / 2,
    };
    const sourceX = (gesture.center.x - stageCenter.x - gesture.transform.x) / gesture.transform.scale;
    const sourceY = (gesture.center.y - stageCenter.y - gesture.transform.y) / gesture.transform.scale;

    setTransform({
      scale: nextScale,
      x: currentCenter.x - stageCenter.x - sourceX * nextScale,
      y: currentCenter.y - stageCenter.y - sourceY * nextScale,
    });
  };

  const endGesture = (event: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    gestureRef.current = null;

    const remaining = [...pointersRef.current.values()];
    dragStartRef.current = remaining.length === 1
      ? { point: remaining[0], transform: transformRef.current }
      : null;
  };

  return <div
    ref={stageRef}
    className={`project-files-media-stage${transform.scale > 1 ? " is-zoomed" : ""}`}
    onPointerDown={beginGesture}
    onPointerMove={continueGesture}
    onPointerUp={endGesture}
    onPointerCancel={endGesture}
    onDoubleClick={(event) => {
      if ((event.target as HTMLElement).closest("button")) return;
      if (transformRef.current.scale > 1) reset();
      else zoomAt(2.5, { x: event.clientX, y: event.clientY });
    }}
  >
    <img
      ref={imageRef}
      src={props.src}
      alt={props.alt}
      draggable={false}
      onLoad={() => setTransform(transformRef.current)}
      style={{
        transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`,
      }}
    />

    {props.hasMultipleImages && <>
      <button
        type="button"
        className="project-files-media-navigation is-previous"
        aria-label={uiText("Vorheriges Bild", "Previous image")}
        title={uiText("Vorheriges Bild", "Previous image")}
        onClick={props.onPrevious}
      >
        <Icons.Previous />
      </button>
      <button
        type="button"
        className="project-files-media-navigation is-next"
        aria-label={uiText("Nächstes Bild", "Next image")}
        title={uiText("Nächstes Bild", "Next image")}
        onClick={props.onNext}
      >
        <Icons.Next />
      </button>
    </>}

    <div className="project-files-media-zoom" role="group" aria-label={uiText("Bildzoom", "Image zoom")}>
      <button
        type="button"
        aria-label={uiText("Verkleinern", "Zoom out")}
        title={uiText("Verkleinern", "Zoom out")}
        disabled={transform.scale <= MIN_SCALE}
        onClick={() => zoomAt(transformRef.current.scale / ZOOM_STEP)}
      >
        <Icons.ZoomOut />
      </button>
      <button
        type="button"
        className="project-files-media-zoom__value"
        aria-label={uiText("Zoom zurücksetzen", "Reset zoom")}
        title={uiText("Zoom zurücksetzen", "Reset zoom")}
        disabled={transform.scale === 1}
        onClick={reset}
      >
        {Math.round(transform.scale * 100)}%
      </button>
      <button
        type="button"
        aria-label={uiText("Vergrößern", "Zoom in")}
        title={uiText("Vergrößern", "Zoom in")}
        disabled={transform.scale >= MAX_SCALE}
        onClick={() => zoomAt(transformRef.current.scale * ZOOM_STEP)}
      >
        <Icons.ZoomIn />
      </button>
    </div>
  </div>;
}
