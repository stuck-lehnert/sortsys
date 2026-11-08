// Deterministic, synthetic GAEB 90 / GAEB 2000 contract examples.
export function legacyContract(phase, format, priceOnly = false, includeAmount = true) {
  if (format === "p") return Buffer.from(`#begin[GAEB]
#begin[PrjInfo][Name]Musterhalle[end]#end[PrjInfo]
#begin[Vergabe][DP]${phase}[end]#begin[VergabeInfo][Wae]EUR[end]#end[VergabeInfo]
#begin[LV]#begin[LVInfo][Name]Vertrag[end][Bez]Putzarbeiten[end]
#begin[LVGlied][Typ]LVStufe[end][Laenge]2[end]#end[LVGlied]
#begin[LVGlied][Typ]Position[end][Laenge]4[end]#end[LVGlied]#end[LVInfo]
#begin[LVBereich][OZ]01[end][Bez]Innenausbau[end]
#begin[Position][OZ]010001[end]${priceOnly ? "" : "[Menge]12,500[end][ME]m2[end]"}
${phase === "83" ? "" : `[EP]12,340[end]${includeAmount ? "[GB]154,25[end]" : ""}`}
${priceOnly ? "" : "#begin[Beschreibung][Kurztext]Innenputz[end][Langtext]Untergrund grundieren und verputzen.[end]#end[Beschreibung]"}
#end[Position]#end[LVBereich]#end[LV]#end[Vergabe]#end[GAEB]`);
  const rows = [
    ["00", [[10, phase], [12, "L"], [62, "11PPPP"], [71, "90"]]],
    ["01", [[2, "Putzarbeiten"]]],
    ["02", [[2, "Musterhalle"]]],
    ["08", [[2, "EUR"]]],
    ["11", [[2, "01"]]],
    ["12", [[2, "Innenausbau"]]],
    ...(!priceOnly ? [["21", [[2, "010001"], [11, "NNN"], [23, "00000012500"], [34, "m2"]]]] : []),
    ...(phase !== "83" ? [["23", [[2, "010001"], [12, "00000012340"], ...(includeAmount ? [[24, "000000015425"]] : [])]]] : []),
    ...(!priceOnly ? [["25", [[2, "Innenputz"]]], ["26", [[5, "Untergrund grundieren und verputzen."]]]] : []),
    ["99", []],
  ];
  return Buffer.from(rows.map(([kind, fields], index) => {
    const chars = Array(80).fill(" ");
    for (const [offset, value] of [[0, kind], [74, String(index + 1).padStart(6, "0")], ...fields])
      [...value].forEach((char, i) => chars[offset + i] = char);
    return chars.join("");
  }).join("\r\n"), "latin1");
}
