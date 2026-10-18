export type Point = { x: number; y: number };
export type Signature = { name: string; strokes: Point[][] };

export function signaturePath(strokes: Point[][]): string {
  if (
    strokes.length > 200 ||
    strokes.reduce((total, stroke) => total + stroke.length, 0) > 10_000
  ) {
    throw new Error("INVALID_SIGNATURE");
  }

  return strokes
    .map((stroke) =>
      stroke
        .map((point, index) => {
          if (
            !Number.isFinite(point.x) ||
            !Number.isFinite(point.y) ||
            point.x < 0 ||
            point.x > 1000 ||
            point.y < 0 ||
            point.y > 500
          ) {
            throw new Error("INVALID_SIGNATURE");
          }

          return `${index === 0 ? "M" : "L"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
        })
        .join(" "),
    )
    .join(" ");
}

export function hasSignature(signature: Signature): boolean {
  return (
    signature.name.trim().length > 0 &&
    signature.name.length <= 160 &&
    signature.strokes.some((stroke) => stroke.length > 1)
  );
}

export function signatureSvg(signature: Signature): string {
  const path = signaturePath(signature.strokes);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 500"><path d="${path}" fill="none" stroke="black" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
