import type { Bounds, PlanSource } from "../types.ts";
import { loadSourceBytes } from "../core/source.ts";

export type LoadedPdfPage = {
  id: string;
  pageNumber: number;
  width: number;
  height: number;
  bounds: Bounds;
};

export type LoadedPdfPlan = {
  type: "pdf";
  pageCount: number;
  pages: LoadedPdfPage[];
  pdf: any;
};

export async function loadPdfPlan(
  source: PlanSource,
  options: {
    workerSrc?: string;
  } = {},
): Promise<LoadedPdfPlan> {
  const pdfjs = await import("pdfjs-dist");
  if (options.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = options.workerSrc;
  } else if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url).toString();
  }

  const data = new Uint8Array(await loadSourceBytes(source));
  const pdf = await pdfjs.getDocument({ data }).promise;
  const pages: LoadedPdfPage[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    pages.push({
      id: `${pageNumber}`,
      pageNumber,
      width: viewport.width,
      height: viewport.height,
      bounds: {
        minX: 0,
        minY: 0,
        maxX: viewport.width,
        maxY: viewport.height,
      },
    });
  }

  return {
    type: "pdf",
    pageCount: pdf.numPages,
    pages,
    pdf,
  };
}

export async function renderPdfPageToCanvas(props: {
  pdf: any;
  pageNumber: number;
  canvas: HTMLCanvasElement;
  scale: number;
}) {
  const page = await props.pdf.getPage(props.pageNumber);
  const dpr = window.devicePixelRatio || 1;
  const viewport = page.getViewport({ scale: Math.max(0.01, props.scale) * dpr });
  const context = props.canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context unavailable");

  props.canvas.width = Math.max(1, Math.ceil(viewport.width));
  props.canvas.height = Math.max(1, Math.ceil(viewport.height));
  props.canvas.style.width = `${Math.ceil(viewport.width / dpr)}px`;
  props.canvas.style.height = `${Math.ceil(viewport.height / dpr)}px`;

  await page.render({
    canvasContext: context,
    viewport,
  }).promise;
}
