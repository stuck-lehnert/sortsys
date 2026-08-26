import type { CadPoint } from "../types.ts";

const MIN_BULGE = 1e-12;

export type CadBulgeArc = {
  center: CadPoint;
  radius: number;
  startAngle: number;
  sweep: number;
};

export function polylineHasBulges(points: readonly CadPoint[], bulges: readonly number[] | undefined): bulges is readonly number[] {
  return points.length >= 2 && Array.isArray(bulges) && bulges.some(bulge => Number.isFinite(bulge) && Math.abs(bulge) > MIN_BULGE);
}

export function bulgeAt(bulges: readonly number[] | undefined, index: number) {
  if (!bulges || index < 0 || index >= bulges.length) return 0;
  const bulge = bulges[index]!;
  return Number.isFinite(bulge) ? bulge : 0;
}

export function bulgeToArc(start: CadPoint, end: CadPoint, bulge: number): CadBulgeArc | null {
  if (!Number.isFinite(bulge) || Math.abs(bulge) <= MIN_BULGE) return null;
  const chordX = end.x - start.x;
  const chordY = end.y - start.y;
  const chord = Math.hypot(chordX, chordY);
  if (chord <= MIN_BULGE) return null;

  const sweep = 4 * Math.atan(bulge);
  if (!Number.isFinite(sweep) || Math.abs(sweep) <= MIN_BULGE || Math.abs(sweep) >= Math.PI * 2) return null;

  const radius = chord / (2 * Math.abs(Math.sin(sweep / 2)));
  const centerDistance = chord / (2 * Math.tan(Math.abs(sweep) / 2));
  const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const leftX = -chordY / chord;
  const leftY = chordX / chord;
  const sign = bulge < 0 ? -1 : 1;
  const center = {
    x: mid.x + leftX * centerDistance * sign,
    y: mid.y + leftY * centerDistance * sign,
  };

  return {
    center,
    radius,
    startAngle: Math.atan2(start.y - center.y, start.x - center.x),
    sweep,
  };
}

function appendPoint(points: CadPoint[], point: CadPoint) {
  const last = points[points.length - 1];
  if (last && last.x === point.x && last.y === point.y) return;
  points.push(point);
}

export function sampleBulgedPolyline(
  points: readonly CadPoint[],
  closed: boolean | undefined,
  bulges: readonly number[] | undefined,
  maxStep = Math.PI / 16,
): CadPoint[] {
  if (!points.length) return [];
  if (!polylineHasBulges(points, bulges)) return [...points];

  const out: CadPoint[] = [];
  appendPoint(out, points[0]!);
  const segmentCount = closed ? points.length : points.length - 1;
  for (let index = 0; index < segmentCount; index += 1) {
    const start = points[index]!;
    const end = points[(index + 1) % points.length]!;
    const arc = bulgeToArc(start, end, bulgeAt(bulges, index));
    if (!arc) {
      appendPoint(out, end);
      continue;
    }
    const steps = Math.max(4, Math.min(96, Math.ceil(Math.abs(arc.sweep) / maxStep)));
    for (let step = 1; step <= steps; step += 1) {
      const angle = arc.startAngle + (arc.sweep * step) / steps;
      appendPoint(out, {
        x: arc.center.x + Math.cos(angle) * arc.radius,
        y: arc.center.y + Math.sin(angle) * arc.radius,
      });
    }
  }
  return out;
}
