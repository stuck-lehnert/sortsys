# Feste, fiktive Dokumentbeispiele

Mit diesen Plänen und E-Mails lassen sich Dokumentabläufe direkt ausprobieren.
Unternehmen, Personen, Adressen und Projektdaten sind frei erfunden. Das Seeding
liest die eingecheckten Dateien unverändert; `manifest.json` hält Größe und
Prüfsumme fest.

- `grundriss-erdgeschoss.{pdf,dwg}` und `grundriss-obergeschoss.{pdf,dwg}`: schematische Pläne mit Wänden, Raumnamen und Maßen.
- `baubesprechung.pdf` und `materialfreigabe.pdf`: Projektkorrespondenz.
- Zugehörige `.eml`- und `.msg`-Dateien: deutsche E-Mail-Texte mit tatsächlichem PDF-Anhang, ohne Tracker, Skripte oder externe Anhangs-URLs.

## Beispiele gezielt erneuern

1. Python-Pakete `reportlab`, `ezdxf` und `pymupdf` in einer isolierten Umgebung installieren.
2. `generate-pdfs.py` ausführen und alle vier PDFs visuell prüfen.
3. Die beiden eingecheckten DXF-Dateien einmalig mit GNU LibreDWG 0.14 konvertieren: `dxf2dwg --as r2000 -o grundriss-erdgeschoss.dwg grundriss-erdgeschoss.dxf`; entsprechend für das Obergeschoss. Anschließend einlesen und sichtbare Elemente prüfen.
4. `generate-mails.mjs` mit installierten Webapp-Abhängigkeiten des Monorepos ausführen.
5. `manifest.json` aktualisieren. Die Rust-Tests prüfen seine Prüfsummen.

Die DXF-Quellen sichern die Reproduzierbarkeit. LibreDWG ist ein Wartungswerkzeug,
keine Laufzeit- oder Browserabhängigkeit; sein Code ist in diesen Beispieldateien
nicht enthalten.
