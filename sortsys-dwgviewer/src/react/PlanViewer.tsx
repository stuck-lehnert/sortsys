import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  Calibration,
  CadDocument,
  CadLayout,
  CadPoint,
  Measurement,
  MeasurementUnit,
  PlanDocument,
  PlanViewerTool,
  Viewport,
} from "../types.ts";
import { drawCadLayout } from "../core/cadRenderer.ts";
import { collectSnapCandidates, layoutBounds, nearestSnapPoint } from "../core/cadGeometry.ts";
import { createCadRenderModel } from "../core/cadRenderModel.ts";
import { fitCadBounds, transformCadPoint, untransformCadPoint, zoomCadAt } from "../core/cadViewport.ts";
import { createInitialViewport, distance, fitBounds, untransformPoint, zoomAt } from "../core/geometry.ts";
import { createMeasurement } from "../core/measurement.ts";
import { drawMeasurements } from "../core/measurementRenderer.ts";
import { parseDwgDocument } from "../dwg/parserClient.ts";
import { loadPdfPlan, renderPdfPageToCanvas, type LoadedPdfPlan } from "../pdf/pdfLoader.ts";

export type PlanViewerHandle = {
  fitToView(): void;
  zoomIn(): void;
  zoomOut(): void;
  resetMeasurements(): void;
};

export type PlanViewerProps = {
  document: PlanDocument;
  className?: string;
  measurements?: Measurement[];
  defaultMeasurements?: Measurement[];
  onMeasurementsChange?: (measurements: Measurement[]) => void;
  calibration?: Calibration | null;
  defaultCalibration?: Calibration | null;
  defaultUnit?: MeasurementUnit;
  onCalibrationChange?: (calibration: Calibration | null) => void;
  initialTool?: PlanViewerTool;
  onError?: (error: Error) => void;
};

type LoadState =
  | { status: "idle" | "loading" }
  | { status: "error"; error: Error }
  | { status: "dwg"; cad: CadDocument }
  | { status: "pdf"; pdf: LoadedPdfPlan };

const INTERACTION_IDLE_MS = 120;
const RENDER_OVERSCAN_PX = 256;
const CAD_INSPECTION_SCALE = 64;

function useSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const resize = () => {
      const rect = node.getBoundingClientRect();
      setSize({ width: rect.width, height: rect.height });
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);

  return size;
}

function controlledState<T>(controlled: T | undefined, fallback: T) {
  return controlled === undefined ? fallback : controlled;
}

function activePageId(loadState: LoadState, selectedIndex: number) {
  if (loadState.status === "dwg") return loadState.cad.layouts[selectedIndex]?.id || "model";
  if (loadState.status === "pdf") return loadState.pdf.pages[selectedIndex]?.id || "1";
  return "pending";
}

function activeBounds(loadState: LoadState, selectedIndex: number) {
  if (loadState.status === "dwg") {
    const layout = loadState.cad.layouts[selectedIndex];
    return layout ? layoutBounds(layout) : null;
  }
  if (loadState.status === "pdf") return loadState.pdf.pages[selectedIndex]?.bounds ?? null;
  return null;
}

function pageOptions(loadState: LoadState) {
  if (loadState.status === "dwg") return loadState.cad.layouts.map((layout, index) => ({
    id: layout.id,
    label: layout.name || `Layout ${index + 1}`,
  }));
  if (loadState.status === "pdf") return loadState.pdf.pages.map(page => ({
    id: page.id,
    label: `Seite ${page.pageNumber}`,
  }));
  return [];
}

function eventPoint(event: React.PointerEvent | WheelEvent, element: HTMLElement): CadPoint {
  const rect = element.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function viewportWithOverscan(viewport: Viewport, overscan: number): Viewport {
  return {
    scale: viewport.scale,
    offsetX: viewport.offsetX + overscan,
    offsetY: viewport.offsetY + overscan,
  };
}

function configureOverscanCanvas(
  canvas: HTMLCanvasElement,
  size: { width: number; height: number },
  dpr: number,
  overscan: number,
) {
  const cssWidth = Math.max(1, Math.ceil(size.width + overscan * 2));
  const cssHeight = Math.max(1, Math.ceil(size.height + overscan * 2));
  canvas.width = Math.max(1, Math.ceil(cssWidth * dpr));
  canvas.height = Math.max(1, Math.ceil(cssHeight * dpr));
  canvas.style.left = `${-overscan}px`;
  canvas.style.top = `${-overscan}px`;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  return { cssWidth, cssHeight };
}

function normalizeMatrixValue(value: number) {
  return Math.abs(value) < 0.0001 ? 0 : value;
}

export function viewportInteractionTransform(renderedViewport: Viewport, interactiveViewport: Viewport) {
  const scale = interactiveViewport.scale / Math.max(renderedViewport.scale, 0.000001);
  const translateX = interactiveViewport.offsetX - renderedViewport.offsetX * scale;
  const translateY = interactiveViewport.offsetY - renderedViewport.offsetY * scale;
  if (
    Math.abs(scale - 1) < 0.0001
    && Math.abs(translateX) < 0.0001
    && Math.abs(translateY) < 0.0001
  ) return "none";
  return `matrix(${normalizeMatrixValue(scale)}, 0, 0, ${normalizeMatrixValue(scale)}, ${normalizeMatrixValue(translateX)}, ${normalizeMatrixValue(translateY)})`;
}

function ToolButton(props: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return <button
    type="button"
    className={`ss-dwgviewer-tool${props.active ? " is-active" : ""}`}
    onClick={props.onClick}
    title={props.title}
  >{props.children}</button>;
}

export const PlanViewer = forwardRef<PlanViewerHandle, PlanViewerProps>(function PlanViewer(props, ref) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pdfCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const initialViewport = useMemo(() => createInitialViewport(), []);
  const pointerRef = useRef<{ id: number; start: CadPoint; viewport: Viewport } | null>(null);
  const interactiveViewportRef = useRef<Viewport>(initialViewport);
  const renderedViewportRef = useRef<Viewport>(initialViewport);
  const pendingDisplayViewportRef = useRef<Viewport>(initialViewport);
  const displayFrameRef = useRef<number | null>(null);
  const wheelIdleTimerRef = useRef<number | null>(null);
  const pdfRenderGenerationRef = useRef(0);
  const size = useSize(containerRef);

  const [loadState, setLoadState] = useState<LoadState>({ status: "idle" });
  const [tool, setTool] = useState<PlanViewerTool>(props.initialTool || "pan");
  const [committedViewport, setCommittedViewport] = useState<Viewport>(initialViewport);
  const [displayViewport, setDisplayViewport] = useState<Viewport>(initialViewport);
  const [selectedPageIndex, setSelectedPageIndex] = useState(0);
  const [internalMeasurements, setInternalMeasurements] = useState<Measurement[]>(props.defaultMeasurements || []);
  const [internalCalibration, setInternalCalibration] = useState<Calibration | null>(props.defaultCalibration || null);
  const [draftPoints, setDraftPoints] = useState<CadPoint[]>([]);
  const [hiddenLayers, setHiddenLayers] = useState<Set<string>>(() => new Set());

  const measurements = controlledState(props.measurements, internalMeasurements);
  const calibration = controlledState(props.calibration, internalCalibration);
  const currentPageId = activePageId(loadState, selectedPageIndex);
  const options = pageOptions(loadState);
  const isCadViewport = loadState.status === "dwg";

  const activeLayout: CadLayout | null = loadState.status === "dwg"
    ? loadState.cad.layouts[selectedPageIndex] ?? null
    : null;
  const activeCadRenderModel = useMemo(() => activeLayout ? createCadRenderModel(activeLayout) : null, [activeLayout]);
  const activeUnit: MeasurementUnit = calibration?.unit || activeLayout?.units || props.defaultUnit || "drawing-unit";

  const snapCandidates = useMemo(() => {
    if (!activeLayout) return [];
    return collectSnapCandidates(activeLayout);
  }, [activeLayout]);

  const clearWheelIdleTimer = () => {
    if (wheelIdleTimerRef.current == null) return;
    window.clearTimeout(wheelIdleTimerRef.current);
    wheelIdleTimerRef.current = null;
  };

  const clearDisplayFrame = () => {
    if (displayFrameRef.current == null) return;
    window.cancelAnimationFrame(displayFrameRef.current);
    displayFrameRef.current = null;
  };

  const clearInteractiveTransform = () => {
    if (contentRef.current) contentRef.current.style.transform = "none";
  };

  const scheduleDisplayViewport = (next: Viewport) => {
    pendingDisplayViewportRef.current = next;
    if (displayFrameRef.current != null) return;
    displayFrameRef.current = window.requestAnimationFrame(() => {
      displayFrameRef.current = null;
      setDisplayViewport(pendingDisplayViewportRef.current);
    });
  };

  const setLiveViewport = (next: Viewport) => {
    interactiveViewportRef.current = next;
    pdfRenderGenerationRef.current += 1;
    if (contentRef.current) {
      contentRef.current.style.transform = viewportInteractionTransform(renderedViewportRef.current, next);
    }
    scheduleDisplayViewport(next);
  };

  const commitViewport = (next: Viewport) => {
    clearWheelIdleTimer();
    clearDisplayFrame();
    interactiveViewportRef.current = next;
    pendingDisplayViewportRef.current = next;
    pdfRenderGenerationRef.current += 1;
    if (contentRef.current) {
      contentRef.current.style.transform = viewportInteractionTransform(renderedViewportRef.current, next);
    }
    setDisplayViewport(next);
    setCommittedViewport(next);
  };

  const setMeasurements = (next: Measurement[]) => {
    if (props.measurements === undefined) setInternalMeasurements(next);
    props.onMeasurementsChange?.(next);
  };

  const setCalibration = (next: Calibration | null) => {
    if (props.calibration === undefined) setInternalCalibration(next);
    props.onCalibrationChange?.(next);
  };

  const fitViewportToBounds = (bounds: NonNullable<ReturnType<typeof activeBounds>>) => (
    isCadViewport
      ? fitCadBounds(bounds, size.width, size.height, 28)
      : fitBounds(bounds, size.width, size.height, 28)
  );

  const zoomViewportAt = (viewport: Viewport, point: CadPoint, nextScale: number) => (
    isCadViewport ? zoomCadAt(viewport, point, nextScale) : zoomAt(viewport, point, nextScale)
  );

  const screenToDocumentPoint = (point: CadPoint, viewport: Viewport) => (
    isCadViewport ? untransformCadPoint(point, viewport) : untransformPoint(point, viewport)
  );

  const drawOverlayForViewport = (viewport: Viewport) => {
    const canvas = overlayCanvasRef.current;
    if (!canvas || !size.width || !size.height) return;
    const dpr = window.devicePixelRatio || 1;
    configureOverscanCanvas(canvas, size, dpr, RENDER_OVERSCAN_PX);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    drawMeasurements(
      ctx,
      measurements,
      viewportWithOverscan(viewport, RENDER_OVERSCAN_PX),
      currentPageId,
      draftPoints,
      activeUnit,
      isCadViewport ? { transformPoint: transformCadPoint } : undefined,
    );
  };

  const finishViewportRender = (viewport: Viewport) => {
    renderedViewportRef.current = viewport;
    interactiveViewportRef.current = viewport;
    drawOverlayForViewport(viewport);
    clearInteractiveTransform();
  };

  const fitToView = () => {
    const bounds = activeBounds(loadState, selectedPageIndex);
    if (!bounds || !size.width || !size.height) return;
    commitViewport(fitViewportToBounds(bounds));
  };

  const zoomBy = (factor: number) => {
    const point = { x: size.width / 2, y: size.height / 2 };
    const current = interactiveViewportRef.current;
    commitViewport(zoomViewportAt(current, point, current.scale * factor));
  };

  useImperativeHandle(ref, () => ({
    fitToView,
    zoomIn: () => zoomBy(1.2),
    zoomOut: () => zoomBy(1 / 1.2),
    resetMeasurements: () => setMeasurements([]),
  }));

  useEffect(() => () => {
    clearWheelIdleTimer();
    clearDisplayFrame();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    const resetViewport = createInitialViewport();
    renderedViewportRef.current = resetViewport;
    interactiveViewportRef.current = resetViewport;
    pendingDisplayViewportRef.current = resetViewport;
    clearInteractiveTransform();
    clearWheelIdleTimer();
    clearDisplayFrame();
    setCommittedViewport(resetViewport);
    setDisplayViewport(resetViewport);
    setLoadState({ status: "loading" });
    setSelectedPageIndex(0);
    setDraftPoints([]);
    setHiddenLayers(new Set());

    const run = async () => {
      try {
        if (props.document.type === "dwg") {
          const cad = await parseDwgDocument(props.document.source, {
            rust: props.document.parser?.rust,
            signal: abort.signal,
          });
          if (!cancelled) setLoadState({ status: "dwg", cad });
        } else {
          const pdf = await loadPdfPlan(props.document.source, {
            workerSrc: props.document.workerSrc,
          });
          if (!cancelled) setLoadState({ status: "pdf", pdf });
        }
      } catch (err) {
        if (cancelled || abort.signal.aborted) return;
        const error = err instanceof Error ? err : new Error(`${err}`);
        props.onError?.(error);
        setLoadState({ status: "error", error });
      }
    };

    void run();
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [props.document]);

  useEffect(() => {
    if (loadState.status !== "dwg" && loadState.status !== "pdf") return;
    if (!size.width || !size.height) return;
    const bounds = activeBounds(loadState, selectedPageIndex);
    if (!bounds) return;
    commitViewport(fitViewportToBounds(bounds));
  }, [loadState, selectedPageIndex, size.width, size.height]);

  useEffect(() => {
    const canvas = baseCanvasRef.current;
    if (!canvas || loadState.status !== "dwg" || !activeLayout || !activeCadRenderModel) return;
    if (!size.width || !size.height) return;

    const dpr = window.devicePixelRatio || 1;
    const { cssWidth, cssHeight } = configureOverscanCanvas(canvas, size, dpr, RENDER_OVERSCAN_PX);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const renderViewport = viewportWithOverscan(committedViewport, RENDER_OVERSCAN_PX);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawCadLayout(ctx, activeLayout, renderViewport, cssWidth, cssHeight, {
      hiddenLayers,
      color: "#111827",
      renderModel: activeCadRenderModel,
    });
    finishViewportRender(committedViewport);
  }, [loadState, activeLayout, activeCadRenderModel, hiddenLayers, committedViewport, size.width, size.height]);

  useEffect(() => {
    const hostCanvas = pdfCanvasRef.current;
    const baseCanvas = baseCanvasRef.current;
    if (!hostCanvas || !baseCanvas || loadState.status !== "pdf") return;
    if (!size.width || !size.height) return;

    const generation = ++pdfRenderGenerationRef.current;
    let cancelled = false;
    const dpr = window.devicePixelRatio || 1;
    configureOverscanCanvas(baseCanvas, size, dpr, RENDER_OVERSCAN_PX);
    const ctx = baseCanvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#f8fafc";
    ctx.fillRect(0, 0, baseCanvas.width, baseCanvas.height);

    const page = loadState.pdf.pages[selectedPageIndex];
    if (!page) return;

    void renderPdfPageToCanvas({
      pdf: loadState.pdf.pdf,
      pageNumber: page.pageNumber,
      canvas: hostCanvas,
      scale: committedViewport.scale,
    }).then(() => {
      if (cancelled || generation !== pdfRenderGenerationRef.current) return;
      ctx.clearRect(0, 0, baseCanvas.width, baseCanvas.height);
      ctx.fillStyle = "#f8fafc";
      ctx.fillRect(0, 0, baseCanvas.width, baseCanvas.height);
      ctx.drawImage(
        hostCanvas,
        Math.round((committedViewport.offsetX + RENDER_OVERSCAN_PX) * dpr),
        Math.round((committedViewport.offsetY + RENDER_OVERSCAN_PX) * dpr),
      );
      finishViewportRender(committedViewport);
    }).catch((err) => {
      if (cancelled || generation !== pdfRenderGenerationRef.current) return;
      const error = err instanceof Error ? err : new Error(`${err}`);
      props.onError?.(error);
      setLoadState({ status: "error", error });
    });

    return () => {
      cancelled = true;
    };
  }, [loadState, selectedPageIndex, committedViewport, size.width, size.height]);

  useEffect(() => {
    drawOverlayForViewport(renderedViewportRef.current);
  }, [measurements, currentPageId, draftPoints, activeUnit, isCadViewport, size.width, size.height]);

  const snapDocumentPoint = (point: CadPoint, viewport: Viewport) => {
    if (!snapCandidates.length) return point;
    const snap = nearestSnapPoint(snapCandidates, point, 9 / Math.max(viewport.scale, 0.01));
    return snap?.point || point;
  };

  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const target = containerRef.current;
    if (!target) return;
    const point = eventPoint(event, target);
    const factor = event.deltaY > 0 ? 1 / 1.12 : 1.12;
    const current = interactiveViewportRef.current;
    const next = zoomViewportAt(current, point, current.scale * factor);
    if (isCadViewport && next.scale >= CAD_INSPECTION_SCALE) {
      commitViewport(next);
      return;
    }
    setLiveViewport(next);
    clearWheelIdleTimer();
    wheelIdleTimerRef.current = window.setTimeout(() => {
      wheelIdleTimerRef.current = null;
      commitViewport(interactiveViewportRef.current);
    }, INTERACTION_IDLE_MS);
  };

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  });

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const screen = eventPoint(event, event.currentTarget);
    if (tool === "pan" || event.button === 1) {
      clearWheelIdleTimer();
      pointerRef.current = { id: event.pointerId, start: screen, viewport: interactiveViewportRef.current };
      return;
    }

    const viewport = interactiveViewportRef.current;
    const docPoint = snapDocumentPoint(screenToDocumentPoint(screen, viewport), viewport);
    if (tool === "distance" || tool === "calibrate") {
      if (draftPoints.length === 0) {
        setDraftPoints([docPoint]);
      } else {
        const points = [draftPoints[0]!, docPoint];
        if (tool === "calibrate") {
          const raw = distance(points[0]!, points[1]!);
          const unit = activeUnit === "drawing-unit" ? props.defaultUnit || "m" : activeUnit;
          const input = window.prompt(`Bekannte Laenge (${unit})`, "1");
          const known = input == null ? Number.NaN : Number.parseFloat(input.replace(",", "."));
          if (Number.isFinite(known) && known > 0 && raw > 0) {
            const nextCalibration: Calibration = {
              documentUnitsPerUnit: raw / known,
              unit,
              label: `${known} ${unit}`,
            };
            setCalibration(nextCalibration);
            const updated = measurements.map(measurement => measurement.pageId === currentPageId && measurement.kind !== "calibration"
              ? { ...measurement, calibration: nextCalibration }
              : measurement);
            setMeasurements([
              ...updated,
              createMeasurement("calibration", currentPageId, points, nextCalibration, `Kalibrierung ${known} ${unit}`),
            ]);
          }
          setDraftPoints([]);
        } else {
          setMeasurements([...measurements, createMeasurement("distance", currentPageId, points, calibration)]);
          setDraftPoints([]);
        }
      }
      return;
    }

    if (tool === "polyline" || tool === "area") {
      setDraftPoints(previous => [...previous, docPoint]);
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const pointer = pointerRef.current;
    if (!pointer || pointer.id !== event.pointerId) return;
    event.preventDefault();
    const screen = eventPoint(event, event.currentTarget);
    setLiveViewport({
      scale: pointer.viewport.scale,
      offsetX: pointer.viewport.offsetX + screen.x - pointer.start.x,
      offsetY: pointer.viewport.offsetY + screen.y - pointer.start.y,
    });
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (pointerRef.current?.id !== event.pointerId) return;
    pointerRef.current = null;
    commitViewport(interactiveViewportRef.current);
  };

  const finishDraft = () => {
    if (tool === "polyline" && draftPoints.length >= 2) {
      setMeasurements([...measurements, createMeasurement("polyline", currentPageId, draftPoints, calibration)]);
      setDraftPoints([]);
    }
    if (tool === "area" && draftPoints.length >= 3) {
      setMeasurements([...measurements, createMeasurement("area", currentPageId, draftPoints, calibration)]);
      setDraftPoints([]);
    }
  };

  const deleteLastMeasurement = () => {
    const index = [...measurements].reverse().findIndex(measurement => measurement.pageId === currentPageId);
    if (index < 0) return;
    const actualIndex = measurements.length - 1 - index;
    setMeasurements(measurements.filter((_, entryIndex) => entryIndex !== actualIndex));
  };

  const toggleLayer = (layerId: string) => {
    setHiddenLayers(current => {
      const next = new Set(current);
      if (next.has(layerId)) next.delete(layerId);
      else next.add(layerId);
      return next;
    });
  };

  const zoomLabel = `${Math.round(displayViewport.scale * 100)}%`;

  return <div className={`ss-dwgviewer ${props.className || ""}`.trim()}>
    <div className="ss-dwgviewer-toolbar">
      <div className="ss-dwgviewer-toolbar-group">
        <ToolButton active={tool === "pan"} onClick={() => setTool("pan")}>Pan</ToolButton>
        <ToolButton active={tool === "distance"} onClick={() => setTool("distance")}>Distanz</ToolButton>
        <ToolButton active={tool === "polyline"} onClick={() => setTool("polyline")}>Linie</ToolButton>
        <ToolButton active={tool === "area"} onClick={() => setTool("area")}>Fläche</ToolButton>
        <ToolButton active={tool === "calibrate"} onClick={() => setTool("calibrate")}>Kalibrieren</ToolButton>
      </div>
      <div className="ss-dwgviewer-toolbar-group">
        <button type="button" className="ss-dwgviewer-tool" onClick={() => zoomBy(1 / 1.2)}>-</button>
        <span className="ss-dwgviewer-zoom">{zoomLabel}</span>
        <button type="button" className="ss-dwgviewer-tool" onClick={() => zoomBy(1.2)}>+</button>
        <button type="button" className="ss-dwgviewer-tool" onClick={fitToView}>Einpassen</button>
      </div>
      {calibration && <span className="ss-dwgviewer-calibration">{calibration.label || calibration.unit}</span>}
      {!!options.length && <select
        className="ss-dwgviewer-select"
        value={options[selectedPageIndex]?.id || ""}
        onChange={(event) => {
          const nextIndex = options.findIndex(option => option.id === event.target.value);
          if (nextIndex >= 0) setSelectedPageIndex(nextIndex);
        }}
      >
        {options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>}
      <div className="ss-dwgviewer-toolbar-group">
        <button type="button" className="ss-dwgviewer-tool" onClick={finishDraft} disabled={!draftPoints.length}>Abschließen</button>
        <button type="button" className="ss-dwgviewer-tool" onClick={() => setDraftPoints([])} disabled={!draftPoints.length}>Abbrechen</button>
        <button type="button" className="ss-dwgviewer-tool" onClick={deleteLastMeasurement} disabled={!measurements.length}>Letzte löschen</button>
      </div>
    </div>

    <div className="ss-dwgviewer-body">
      {loadState.status === "dwg" && !!loadState.cad.layers.length && <aside className="ss-dwgviewer-layers">
        <div className="ss-dwgviewer-panel-title">Layer</div>
        {loadState.cad.layers.map(layer => <label key={layer.id} className="ss-dwgviewer-layer">
          <input
            type="checkbox"
            checked={!hiddenLayers.has(layer.id)}
            onChange={() => toggleLayer(layer.id)}
          />
          <span>{layer.name}</span>
        </label>)}
      </aside>}

      <div
        ref={containerRef}
        className="ss-dwgviewer-canvas-wrap"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={finishDraft}
      >
        <div ref={contentRef} className="ss-dwgviewer-canvas-content">
          <canvas ref={baseCanvasRef} className="ss-dwgviewer-canvas" />
          <canvas ref={overlayCanvasRef} className="ss-dwgviewer-overlay" />
        </div>
        <canvas ref={pdfCanvasRef} hidden />
        {loadState.status === "loading" && <div className="ss-dwgviewer-state">Plan wird geladen...</div>}
        {loadState.status === "error" && <div className="ss-dwgviewer-state ss-dwgviewer-state--error">{loadState.error.message}</div>}
        {loadState.status === "dwg" && !!loadState.cad.warnings.length && <div className="ss-dwgviewer-warnings">
          {loadState.cad.warnings.slice(0, 3).map((warning, index) => <div key={`${index}-${warning}`}>{warning}</div>)}
        </div>}
      </div>
    </div>
  </div>;
});
