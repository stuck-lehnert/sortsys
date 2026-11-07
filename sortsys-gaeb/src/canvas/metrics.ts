const metrics = new Map<string, TextMetrics>();
const LIMIT = 6000;
let fontRevision = 0;
export const fontMetricsRevision = () => fontRevision;

/** Measurements use document coordinates, independent of zoom and canvas tiles.
 * Keep unchanged words and font metrics out of the browser's text shaper while
 * typing. Bound the cache so long sessions do not retain every draft. */
export function measureText(context: CanvasRenderingContext2D, value: string) {
  const key = `${context.font}\0${context.textBaseline}\0${context.direction}\0${context.letterSpacing}\0${context.wordSpacing}\0${value}`;
  const cached = metrics.get(key);
  if (cached) return cached;
  const measured = context.measureText(value);
  if (metrics.size >= LIMIT) metrics.delete(metrics.keys().next().value!);
  metrics.set(key, measured);
  return measured;
}

if (typeof document !== "undefined")
  document.fonts?.addEventListener("loadingdone", () => {
    metrics.clear();
    fontRevision++;
  });
