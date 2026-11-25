/** The organization edits this native Typst source, never generated document data. */
export const DEFAULT_GAEB_TEMPLATE = `// data: title, project, date, currency, sender, language
// #asset("logo.png", width: 30mm) includes an image or a PDF page.
// #attachment("terms.pdf", width: 100%) includes all PDF pages.
#let document-header(data) = align(right)[
  #text(size: 9pt)[#data.sender.name]
]
#let document-footer(data) = context align(center)[
  #text(size: 8pt)[#if data.language == "de" { [Seite ] } else { [Page ] }#counter(page).display("1")]
]
#let table-style = (
  stroke: (x: none, y: 0.4pt + rgb("#d5d7db")),
  inset: (x: 4pt, y: 6pt),
)
#let document-style(data, body) = {
  set page(paper: "a4", margin: (left: 16mm, right: 16mm, top: 24mm, bottom: 20mm), header: document-header(data), footer: document-footer(data))
  set text(font: "NimbusSanL", size: 10.5pt, lang: data.language)
  set par(leading: 3pt)
  body
}
`;
