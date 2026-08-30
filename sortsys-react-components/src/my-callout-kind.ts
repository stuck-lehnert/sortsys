export function resolveCalloutKind(kind?: string, color?: string) {
  if (kind) return kind;

  const normalized = (color ?? "blue").toLowerCase();

  if (normalized === "green" || normalized === "teal" || normalized === "lime") {
    return "success";
  }

  if (normalized === "red" || normalized === "pink" || normalized === "deeporange") {
    return "danger";
  }

  if (normalized === "amber" || normalized === "yellow" || normalized === "orange") {
    return "warning";
  }

  return "info";
}
