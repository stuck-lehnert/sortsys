# sortsys im Browser

Angebote, Projekte und Dokumente griffbereit: Die Webapp verbindet den Arbeitsalltag
von Auftragnehmern in einer Oberfläche auf Deutsch und Englisch. React 19 und
React Router 7 bilden die Grundlage; API-Client, Bedienelemente, GAEB-Editor und
Planansicht sind lokale Pakete des Monorepos.

## Entwicklung

Die vollständige Umgebung mit PostgreSQL, MinIO, Euro-Office, diagrams.net, API,
Hintergrunddiensten, erzeugtem Client und Beispieldaten im Hauptverzeichnis starten:

```bash
./scripts/dev
```

Die Webapp ist unter `http://127.0.0.1:5173` erreichbar.

Für das Frontend allein zunächst den API-Client bauen und Viewer-Abhängigkeiten installieren:

```bash
cd sortsys-api-v2/client
bun install --frozen-lockfile
bun run build

cd ../../sortsys-dwgviewer
npm ci

cd ../sortsys-webapp-v2
npm ci
npm run dev
```

Der Entwicklungsclient erwartet die API unter `http://127.0.0.1:3000`.

## Prüfungen und Produktionsbuild

```bash
npm run typecheck
npm run build
```

Bei Oberflächenänderungen die [UI-Leitlinien](../UX_UI_GUARDRAILS.md) beachten und
Browserbeispiele mit dem produktiven Stylesheet prüfen:

```bash
bun run test:ui
```

Client und DWG-WebAssembly vorher bauen. Die Beispiele prüfen beide Sprachen,
Tastaturbedienung, Zugänglichkeit und Dokumentdialoge. `SORTSYS_UI_ASSETS` kann ein
vorhandenes `build/client`-Verzeichnis auswählen.

Nginx liefert den statischen Produktionsbuild aus. `API_UPSTREAM` bestimmt die
interne API-Adresse, `ONLYOFFICE_UPSTREAM` und `DRAWIO_UPSTREAM` die Editorziele.
`CLIENT_MAX_BODY_SIZE` beträgt standardmäßig `64m`.

## Dokumente dort bearbeiten, wo sie gebraucht werden

DOCX, PPTX, XLSX und diagrams.net-Dateien lassen sich direkt bei Projektanhängen
anlegen. Office-Dokumente öffnen in Euro-Office, Diagramme im eingebetteten
Editor. Beide speichern über authentifizierte API-Prozeduren.

Hochgeladene PDFs werden im Hintergrund indiziert. Die Ansicht **Dokumente**
durchsucht Dateinamen und erkannten PDF-Text aller zugänglichen Projekte.

Projektanhänge öffnen unter `/projects/:id/files/:fileId` über dem weiterhin
geladenen Dateibrowser. Suche und Auswahl bleiben erhalten. Direktlinks und
Neuladen öffnen die Datei erneut; Zurück schließt mit Speicherprüfung, Vorwärts
öffnet wieder. Die Bildgalerie ersetzt die Datei-ID im selben Verlaufseintrag.
Ältere Links über `/projects/:id/files?file=:fileId` werden auf den neuen Pfad
normalisiert. Nicht zugängliche Dateien zeigen eine passende Fehlermeldung.

PDF-Anhänge nutzen den lokal bereitgestellten [Mozilla-PDF.js-Viewer](https://github.com/mozilla/pdf.js)
mit Suche, Seitennavigation, Zoom, Druck und Download. Er wird bei Bedarf in der
Oberflächensprache geladen. Hinweise zu Lizenz und Aktualisierung stehen bei der
[eingebundenen Veröffentlichung](vendor/pdfjs/README.md).

## Lokale Pakete

- `@sortsys/v2-client`: typisierte Abfragen, Änderungen, Authentifizierung und Caching.
- `@sortsys/react-components`: gemeinsame Bedienelemente und Gestaltung.
- `@sortsys/dwgviewer`: PDF- und DWG-Pläne.
- `@sortsys/gaeb`: native Dokumentbearbeitung und Kalkulation im Canvas-Editor.

## Lizenz

Für dieses Paket gilt die [GNU Affero General Public License v3.0 only](../LICENSE).
