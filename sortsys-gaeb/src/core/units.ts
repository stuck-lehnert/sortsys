/** GAEB QU allows four Unicode characters. Recognize common written names,
 * but retain unknown values verbatim and never truncate their meaning. */
export function gaebUnit(input: string): string {
  const value = input.trim();
  const aliases: Record<string, string> = {
    stück: "Stk",
    stueck: "Stk",
    stücke: "Stk",
    "stck.": "Stk",
    "pausch.": "psch",
    "lfd.m": "lfm",
    piece: "pcs",
    pieces: "pcs",
    pauschal: "psch",
    pauschale: "psch",
    stunde: "h",
    stunden: "h",
    hour: "h",
    hours: "h",
    meter: "m",
    metre: "m",
    metres: "m",
    meters: "m",
    quadratmeter: "m²",
    kubikmeter: "m³",
    "laufender meter": "lfm",
    "laufende meter": "lfm",
  };
  const key = value.toLocaleLowerCase("de-DE");
  const unit = Object.hasOwn(aliases, key) ? aliases[key]! : value;
  if (Array.from(unit).length > 4) throw new Error("unit-too-long");
  return unit;
}
