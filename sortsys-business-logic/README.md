# Gemeinsame Business-Logik

`@sortsys/business-logic` ist ein lokales, privates TypeScript-Paket für Webapp und mobile App. Beide Apps binden es mit `file:../sortsys-business-logic` ein. Die Paketexporte enthalten keine React-, Browser-Client-, Expo- oder Dateisysteminitialisierung. API-Datentypen werden ausschließlich über Type-only-Imports aus dem vorhandenen Contract verwendet.

## Module

- `@sortsys/business-logic/pdf`: Typst-Syntax, A4-/DIN-Layout, Tabellen, Karten, Bild- und Signaturbereiche sowie Tages-, Regie-, Wochen- und Kostenberichtvorlagen. Die Kostenaufbereitung enthält Angebote, Rechnungen, Gemeinkosten, Material, Arbeitsstunden, Nachunternehmer und Werkzeugbuchungen; ergänzende Wochendaten liefern die Plattformadapter.
- `@sortsys/business-logic/calendar`: ISO-Wochen, Kalendertage und Tagesindizes. UI-Kalender verwenden den lokalen Modus; PDF-Vorlagen verwenden UTC. Tagesindizes beruhen auf Kalendertagen und bleiben bei Sommerzeitwechseln korrekt.
- `@sortsys/business-logic/domain`: Produkt- und Regiebezeichnungen, Personen- und Werkzeugnamen, Anschriften und die Auswahl von Anzeigeeinheiten.
- `@sortsys/business-logic/signatures`: Punkt-/Strichmodelle, Signaturprüfung und SVG-Erzeugung.
- `@sortsys/business-logic/encoding`: Base64-Kodierung für Binärassets.
- Hauptexport: gemeinsame Dezimal-/EUR-Formatierung und Client-Sichtbarkeitsprüfung. Die Adapter übergeben ihre bestehende Rollenpolicy; die serverseitige Autorisierung bleibt verpflichtend.

Die kanonischen Nimbus-Sans-L-Schriftdateien und unveränderten Herkunfts-/Lizenzdokumente liegen unter `assets/fonts/nimbus-sans-l/`. Web-Vite und der mobile Typst-Bundler lesen diese Dateien. Beide Apps verwenden den gepinnten Compiler `@myriaddreamin/typst-ts-web-compiler@0.7.0`; der Webadapter lädt die lokale WASM-Datei statt eines CDN-Compilers.

## Plattformgrenzen

API-Aufrufe, Sitzungsbindung, sichere Bildabrufe, WebView-Protokoll, Dateisystem, PDF-Freigabe und Archivierung bleiben in den Apps. Die Builder erhalten gespeicherte Geschäftsdaten, verfügbare Namenszuordnungen, Sprache, Firmenkopf, Bilder und Exportzeitpunkt als Eingaben. JavaScript-Codegenerierung aus Strings bleibt im mobilen Compiler gesperrt.

PDF-Datenformatierung verwendet feste DE/EN-Regeln und UTC-Datumsdarstellung. Die gemeinsame Dezimalformatierung benötigt keine plattformspezifischen Intl-/ICU-Daten. Stabile Bildpfade und der serialisierte Webcompiler verhindern, dass parallel vorbereitete Exporte dieselben Schattenassets überschreiben.

Bei identischen Eingaben erzeugen Web- und Mobile-Builder dieselbe Typst-Syntax. Unterschiedliche Datenstände, Berechtigungen, Sprache, Firmenkopfoptionen oder verfügbare Bilddaten können den Dokumentinhalt verändern. Die tatsächliche WebView-Ausführung und Systemfreigabe müssen zusätzlich auf iOS und Android geprüft werden.

## Prüfungen

`npm --prefix sortsys-mobile test` führt auch die Pakettests aus. Die mobilen Paritätstests vergleichen Tages-, Regie-, Wochen- und Kostenberichte für Deutsch und Englisch zeichengetreu mit der kanonischen Web-Dokumentfolge. Weitere Tests prüfen Dezimalrundung, Zeitzonen, Sommerzeit, ISO-Jahresgrenzen, Einheiten, Namen und Rollenpolicies.

`npm --prefix sortsys-mobile run check:typst` kompiliert echte PDFs mit der lokalen WASM-Engine, den gemeinsamen Schriften und gesperrter String-Codegenerierung. Die vorhandenen Web-PDF-Tests prüfen dieselben Layout- und Regiebausteine einschließlich Logos und mehrseitiger Tabellen.

Nach Änderungen an Compiler- oder Schriftassets ist `npm --prefix sortsys-mobile run typst:build` erforderlich. Änderungen an Schriftdateien werden durch die festgelegten SHA-256-Prüfwerte erkannt. Die Bedingungen für die Weitergabe der Schriftsoftware müssen vor einer Veröffentlichung des App-Pakets abschließend geprüft werden.
