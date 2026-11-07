# Einheitliche PDF-Dokumente aus dem Browser

Ob Angebot, Lieferschein oder Projektbericht: gemeinsame Layoutregeln sorgen für
wiedererkennbare, gut lesbare Ausgaben. Browserexporte verwenden
`app/lib/pdfLayout.ts`; `app/lib/pdf.ts` fügt Tabellen, Karten, Bilder,
Unterschriften und Textabsätze ein. WASM-Compiler und Nimbus-Sans-L-Schriften
bleiben auf dem Client. Das Layout benötigt keine Typst-Universe-Pakete.

Normal- und Fettschnitt liegen samt Lizenz und Herkunftsnachweis unter
`public/fonts/nimbus-sans-l`. Typst verwendet den internen Familiennamen
`NimbusSanL`. Der Renderer lädt beide vom Anwendungsursprung. Fehlende Schriften
brechen den Export ab, statt unbemerkt Ersatzschriften zu verwenden. Die Schrift
steht auch im Lizenzverzeichnis der Anwendung.

Die Trennung zwischen Inhalt und Seitenlayout folgt dem Ansatz von
[invoice-pro](https://typst.app/universe/package/invoice-pro) und
[letter-pro](https://typst.app/universe/package/letter-pro). Die Implementierung
wird lokal gepflegt und übernimmt keine Berechnungslogik dieser Pakete.

## Seitenlayouts

Das Standardlayout `report` verwendet A4, links 25 mm und rechts 20 mm Rand,
10 pt Fließtext, 9 pt Tabellen und 8 pt Wochenmatrizen. `PDF_TYPOGRAPHY` legt die
gemeinsamen Größen fest: Berichtstitel 18 pt, Briefbetreff 14 pt,
Abschnittsüberschriften 11 pt, Eintrags-/Kontaktüberschriften 10 pt,
Tabellenköpfe 9 pt sowie Nebenhinweise und Exportmetadaten 8 pt.
Zusammenfassungswerte bleiben bei 9 pt; zentrale finanzielle Ergebnisse verwenden
10 pt. Fettdruck hebt Ergebnisse ohne übergroße Zahlen hervor. Haupttext ist
schwarz, nachrangige Beschriftungen und Hinweise sind dunkelgrau. Tabellen nutzen
klare Spaltenabstände, feine waagerechte Zeilentrenner und eine stärkere Linie
unter dem Kopf. Senkrechte Rahmen und Hintergrundfüllungen entfallen.
Normale Tabellen haben vertikal 6 pt Zellabstand, Wochenmatrizen und Listen mit
mehr als 20 Positionen 5 pt.

Der kompakte Unternehmenskopf zeigt rechts oben ein proportional auf höchstens
48 × 16 mm skaliertes Logo. Es beginnt 10 mm unter dem Seitenrand, auf derselben
Höhe wie bei Briefen. Links stehen postalische Absenderdaten, darunter eine feine
Trennlinie. In Berichts- und Briefköpfen ersetzt das Logo den Unternehmensnamen;
ohne Logo erscheint dieser als Text. Postalischer Absender und Rücksendezeile
bleiben in beiden Fällen verfügbar. Die Kopfhöhe folgt dem tatsächlichen Inhalt.
Ohne Logo nutzt der Absender die volle Breite; engere Abstände schließen die
ungenutzte Logofläche. Der erste Kopf nutzt den oberen Randbereich; Folgeseiten
behalten regulär 25 mm oberen Rand. Dieses Layout dient Projektberichten,
Inventuren und Tabellenexporten und reserviert kein Anschriftenfenster.

Für Korrespondenz, Rechnungen und Lieferscheine gilt `kind: 'letter'`.
Standard ist Form B; Form A verschiebt das Anschriftenfenster 18 mm nach oben.
Das 85 × 45 mm große Feld beginnt bei x = 20 mm und y = 45 mm (B) oder 27 mm (A).
Sein Text startet bei x = 25 mm, die Empfängerzone 17,7 mm unter der Feldoberkante.
Der Informationsblock beginnt bei x = 125 mm und y = 50 mm (B) oder 32 mm (A).

Diese Maße orientieren sich an der
[letter-pro-Referenzimplementierung](https://github.com/Sematre/typst-letter-pro/blob/main/src/lib.typ).
DIN Media bietet außerdem eine offizielle
[Geschäftsbriefvorlage nach DIN 5008:2020](https://www.dinmedia.de/de/themenseiten/din-5008/mustervorlage-geschaeftsbrief-din5008).
Die Implementierung regelt die Seitengestaltung. Wortlaut, vollständige
Anschriften, Ländernamen, Rechnungs-Pflichtangaben und die Formatierung gelieferter
Beträge verantwortet der jeweilige Dokumentgenerator. Berichte teilen Typografie
und Ränder, sind aber keine Geschäftsbriefformulare.

## Dokumenttyp ergänzen

Bestehende Aufrufer von `renderStructuredPdf` und `renderStructuredPdfBatch`
verwenden das gemeinsame Layout automatisch. `layout` und `paragraphs` ergänzen
einen Brief:

```ts
await renderStructuredPdf({
  title: 'Bestätigung Ihres Auftrags',
  reportLabel: 'Auftragsbestätigung',
  sections: [],
  paragraphs: [
    'Sehr geehrte Damen und Herren,',
    'wir bestätigen Ihren Auftrag vom 3. Oktober 2026.',
    'Mit freundlichen Grüßen',
    'Erika Musterfrau',
  ],
  layout: {
    kind: 'letter',
    form: 'B',
    date: new Date('2026-10-03T12:00:00'),
    sender: { name: 'Musterbau GmbH', lines: ['Musterstraße 1', '12345 Musterstadt'] },
    recipient: { name: 'Beispiel GmbH', lines: ['Einkauf', 'Zielstraße 2', '54321 Beispielstadt'] },
    information: [{ label: 'Unser Zeichen', value: 'AB-123' }],
    footer: ['Geschäftsführung: Erika Musterfrau', 'USt-IdNr.: DE123456789'],
  },
});
```

Der Dokumenttitel dient als Betreff ohne vorangestelltes „Betreff“. Zwischen
Anschriftenfeld und Betreff sowie Betreff und Text stehen jeweils zwei Zeilen.
Längere Informationsblöcke verschieben den Betreff nach unten. Absenderköpfe
werden gegen die verfügbare Höhe der gewählten Form geprüft. Empfängeranschriften
erlauben sechs Zeilen, Vermerke vier. Überlange Anschriftenzeilen werden höchstens
auf 8 pt verkleinert, Rücksendezeilen auf 6 pt. Reicht das nicht, scheitert die
Kompilierung, statt Text überlappen zu lassen. Inhalte werden als Text kodiert,
auch bei Typst-Sonderzeichen.

`returnAddress` überschreibt die kompakte Absenderzeile. `foldMarks: false`
schaltet Falt- und Lochmarken ab. `footer` wiederholt sich auf jeder Seite und
reserviert bei Bedarf zusätzlichen Platz. Folgeseiten zeigen den Dokumenttitel.
Jedes Dokument eines Sammelexports beginnt auf einer neuen Seite und erhält eine
eigene Nummerierung „Seite x / y“.

## Inhalte strukturieren

`PdfTableSection.presentation` trennt Inhalt und Darstellung:

- `facts`: zweispaltige Tabelle mit Beschriftung und Wert in 9 pt. Ausdrücklich fette Werte kennzeichnen die ganze Zeile als Ergebnis. Standard für kopflose Zweispaltenabschnitte, etwa Projektmetadaten.
- `summary`: Beschriftung und Wert in gelieferter Reihenfolge. `bold` oder `emphasis: 'primary'` betonen die ganze Zeile; Nebenwerte bleiben gleich groß. Geeignet für Lieferkosten, gemeldete Stunden, Anwesenheitszahlen und Inventurergebnisse.
- `metrics`: finanzielle Zusammenfassung mit Beschriftungen links und rechtsbündigen Beträgen. Zentrale Ergebnisse stehen in 10 pt, andere in 9 pt. `detail` eines formatierten Werts zeigt Prozentsätze und Eintragszahlen kleiner unter dem Betrag.
- `text`: Fließtext über volle Breite; Standard für kopflose einspaltige Abschnitte.
- `entries`: fette Beschriftung mit Datum, gefolgt von Fließtext über volle Breite. Geeignet für Tagesbeschreibungen und Projektnotizen, die sonst in schmalen Zellen landen würden.
- `table`: Positionslisten mit wiederholten Abschnittstiteln und Spaltenköpfen, feinen waagerechten Trennern und ausgerichteten Zahlenspalten. `totalRows` ergänzt eine fette Endsumme, die nur am Ende erscheint.

Kontakte verwenden je Person ein schlichtes Zweispaltenlayout: fetter Name und
kleinere Rolle über einer feinen Linie, danach nachrangige Beschriftungen und
Kontaktdaten in festen Spalten. Weißraum trennt Personen. Gewöhnliche Datensätze
bleiben zusammen. Überlange Einträge dürfen mit wiederholtem Namenskopf umbrechen,
statt die Seite zu überschreiten. `trailingSections` stellt ergänzende Notizen
hinter die Kontakte; das Projektdatenblatt zeigt somit Projektinformationen,
Kontakte und danach Notizen. Fotos behalten ihr Seitenverhältnis innerhalb eines
55 mm hohen Rahmens und bleiben bei ihrer Bildunterschrift. Unterschriftenfelder
bleiben zusammen, haben 8,46 mm Abstand über dem Block und reservieren 18 mm zum
Schreiben. Leere Abschnitte zeigen eine ausdrückliche Meldung.

`buildPdfProductSection` erhält benannte Produktfelder. Produktnummern stehen
links von der Beschreibung in einer eigenen Spalte „Nr.“, regulär 15 mm breit
und für längere Nummern bis zu 25 mm. Mengen und Grundmengenumrechnungen teilen
eine Spalte. Die bepreiste Fassung erklärt Durchschnittspreise je Grundeinheit.
Regieberichte verwenden denselben Baustein mit `showPrices: false` und
`showNumbers: false`. Interne Produktnummern erscheinen auch bei unbekannten
Produkten nicht. Statt der internen Bezeichnung gilt das optionale
`regieReportName`, bearbeitbar als „Bezeichnung für Regieberichte“. Bei fehlendem
oder leerem Wert gilt `productTitle`. Das Feld fließt in die Produktvolltextsuche
ein. Einzelne und projektweite PDF-/Excel-Regieexporte teilen diese Namensregel.
Regieberichte zeigen Stunden je Mitarbeiter und Tag ohne Gesamtstundenmetadaten,
Mitarbeitersummen oder Summenzeile. `formatPdfNumber` entfernt überflüssige
Nachkommanullen und erhält die bisherige Genauigkeit von höchstens vier
Nachkommastellen. Geldbeträge verwenden weiterhin Währungsformatierung.

Kostendetails und Inventuren verwenden kompakte numerische Daten, damit schmale
Spalten keine umgebrochenen Monatsnamen enthalten. Wochenkosten unterscheiden
Einzel- und Gemeinkosten und gruppieren Material sowie Personal. Ein wöchentlicher
Projektkostenexport bildet ein durchgängiges Dokument: ein Unternehmenskopf mit
Titel, eine Gesamtübersicht und chronologische Wochengruppen mit 14-pt-Überschrift
sowie Datumsbereich in 8 pt. Kategorien und Positionen fließen ohne erzwungene
Seitenumbrüche. Jede Überschrift bleibt bei ihren ersten Kostenzeilen.
Wiederholte Tabellenköpfe auf Folgeseiten enthalten die Kalenderwoche in 8 pt.
Seitenzahlen gelten für den gesamten Bericht; unabhängige Dokumente eines
Sammelexports behalten separate Zählungen. `StructuredPdfDocument.groups` bietet
diese Struktur für weitere gruppierte Berichte; `buildWeeklyProjectCostsPdfDocument`
liefert Gesamtübersicht und Wochengruppen des Kostenberichts.

Allgemeine Tabellenexporte mit mehr als sechs Spalten verwenden
`buildTablePdfDocument` für ausgerichtete Beschriftung-/Wert-Datensätze mit
abgesetztem Kopf. Sämtliche Spaltennamen und Werte bleiben erhalten. Schmale
Exporte nutzen gewöhnliche Spaltentabellen, geben Beschreibungsspalten mehr Raum
und richten Text standardmäßig links aus. Beide Varianten beginnen mit einer
kompakten Übersicht der Eintrags- und Feldzahlen.

Der Renderer ergänzt Mandantenname und Logo, soweit vorhanden. Aufrufer geben
postalische Absenderdaten sowie rechtliche und Bankangaben über `sender` und
`footer` mit. Lieferscheine verwenden die Projektkundenanschrift in Form B, wenn
sie vorliegt; andernfalls gilt das Berichtslayout.

## Prüfungen und Vorschau

`bun run test:pdf` führt Datenprüfung und Browser-WASM-Kompilierung immer mit den
mitgelieferten Normal-/Fettschriften aus. Mit installierter Typst-CLI kompiliert
der Integrationstest Form A/B und einen mehrseitigen Bericht. PDF.js liest Texte
aus und prüft Anschriftenpositionen, Referenzpositionen, Tabellenköpfe und
Seitenzahlen je Dokument. Ohne CLI entfällt diese Prüfung. Auch CLI-Tests
verwenden Nimbus Sans L ohne Ersatzschriften.

Der Browsertest kompiliert repräsentative Dokumenttypen, prüft tatsächliche
PDF-Textgrenzen und Überschneidungen benachbarter Spalten. Alle 90 Positionen
eines langen Lieferscheins müssen mit wiederholten Köpfen und zugehörigen
Unterschriftenfeldern erhalten bleiben. Gemessene Schriftgrößen prüfen die
zurückhaltende Hierarchie von Titeln, Abschnitten, Beschriftungen und Ergebnissen
für jedes Beispieldokument. Kontaktprüfungen decken Feld-/Wertausrichtung,
anschließende Notizen und alle zwölf Personen eines mehrseitigen Datenblatts ab.
Logoprüfungen messen Seitenverhältnis, Höchstgröße, Ausrichtung am rechten Rand
und entfallenden Leerraum ohne Logo.

Ein Wochenkostentest prüft alle 100 Positionen aus drei Wochen, genau einen großen
Titel und Unternehmenskopf, fortlaufende Seitenzahlen, wiederholte Wochen-/Spaltenköpfe
und keine alleinstehende Wochenüberschrift. Drei kompakte Wochen müssen auf eine
Seite passen, auch beim gemeinsamen Export zweier solcher Berichte.

`bun run preview:pdf` erzeugt `/tmp/sortsys-pdf-preview/beispiele.pdf` samt
Typst-Quelle, einzelne PDFs mit Quellen für alle 14 Beispiele und
`projektkosten-wochenweise.pdf` für einen durchgängigen Dreiwochenbericht.
Ein Ausgabeverzeichnis kann als Argument übergeben werden. Die Sammlung enthält
Lieferscheine einschließlich 90 Positionen, Tages-/Wochenberichte,
Anwesenheits- und Regieberichte, Gesamt-/Wochenkosten, Inventuren, Projektkontakte
mit mehrseitiger Liste und schmale/breite Tabellenexporte. Compiler und Schriften
entsprechen dem Browserexport; Platzhalterbilder decken Hoch- und Querformat ab.
`pdftoppm -png` rendert PDFs zur Sichtprüfung.
