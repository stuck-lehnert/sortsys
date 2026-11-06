import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { PAGE_WIDTH } from "./types";
import { displayPixelRatio, MAX_ZOOM } from "./raster";

const clamp = (value: number) => Math.max(0.25, Math.min(MAX_ZOOM, value));

/** Zoom in document coordinates; the point under the gesture stays stationary. */
export function useCanvasViewport(
  initialZoom: number | null = null,
  onChange?: (zoom: number | null) => void,
) {
  const changed = useRef(onChange);
  changed.current = onChange;
  const container = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(initialZoom ?? 1);
  const [pixelRatio, setPixelRatio] = useState(displayPixelRatio);
  const [fit, setFit] = useState(initialZoom === null);
  useEffect(() => {
    const timer = setTimeout(() => changed.current?.(fit ? null : zoom), 200);
    return () => clearTimeout(timer);
  }, [zoom, fit]);
  const value = useRef(zoom);
  const anchor = useRef<{
    x: number;
    y: number;
    clientX: number;
    clientY: number;
  } | null>(null);
  useEffect(() => {
    let query: MediaQueryList;
    const update = () => {
      setPixelRatio(displayPixelRatio());
      query?.removeEventListener("change", update);
      query = window.matchMedia(
        `(resolution: ${window.devicePixelRatio || 1}dppx)`,
      );
      query.addEventListener("change", update);
    };
    update();
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      query.removeEventListener("change", update);
    };
  }, []);
  const changeZoom = useCallback(
    (requested: number, point?: { x: number; y: number }, fitting = false) => {
      const viewport = container.current;
      const next = clamp(requested);
      if (!viewport) return;
      if (next === value.current) {
        setFit(fitting);
        return;
      }
      const paper = viewport.querySelector<HTMLElement>(".gaeb-document-paper");
      const bounds = viewport.getBoundingClientRect();
      const x = point?.x ?? bounds.left + viewport.clientWidth / 2;
      const y = point?.y ?? bounds.top + viewport.clientHeight / 2;
      if (paper) {
        const rect = paper.getBoundingClientRect();
        anchor.current = {
          x: (x - rect.left) / value.current,
          y: (y - rect.top) / value.current,
          clientX: x,
          clientY: y,
        };
      }
      value.current = next;
      setFit(fitting);
      setZoom(next);
    },
    [],
  );
  const fitWidth = useCallback(() => {
    const node = container.current;
    if (node)
      changeZoom(
        Math.min(1, (node.clientWidth - 48) / PAGE_WIDTH),
        undefined,
        true,
      );
  }, [changeZoom]);
  useEffect(() => {
    if (initialZoom === null) fitWidth();
    else if (initialZoom !== value.current) changeZoom(initialZoom);
  }, [initialZoom, changeZoom, fitWidth]);
  useLayoutEffect(() => {
    const point = anchor.current,
      viewport = container.current;
    const paper = viewport?.querySelector<HTMLElement>(".gaeb-document-paper");
    if (!point || !viewport || !paper) return;
    anchor.current = null;
    const rect = paper.getBoundingClientRect();
    viewport.scrollLeft += rect.left + point.x * zoom - point.clientX;
    viewport.scrollTop += rect.top + point.y * zoom - point.clientY;
  }, [zoom]);
  useEffect(() => {
    const node = container.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      if (fit) fitWidth();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [fit, fitWidth]);
  useEffect(() => {
    const node = container.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const units =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? node.clientHeight
            : 1;
      changeZoom(value.current * Math.exp(-event.deltaY * units * 0.002), {
        x: event.clientX,
        y: event.clientY,
      });
    };
    let gestureZoom = 1;
    const start = (event: Event) => {
      event.preventDefault();
      gestureZoom = value.current;
    };
    const gesture = (event: Event) => {
      event.preventDefault();
      const native = event as Event & {
        scale: number;
        clientX: number;
        clientY: number;
      };
      if (Number.isFinite(native.scale))
        changeZoom(gestureZoom * native.scale, {
          x: native.clientX,
          y: native.clientY,
        });
    };
    node.addEventListener("wheel", wheel, { passive: false });
    node.addEventListener("gesturestart", start, { passive: false });
    node.addEventListener("gesturechange", gesture, { passive: false });
    return () => {
      node.removeEventListener("wheel", wheel);
      node.removeEventListener("gesturestart", start);
      node.removeEventListener("gesturechange", gesture);
    };
  }, [changeZoom]);
  return { container, zoom, pixelRatio, fit, changeZoom, fitWidth };
}
