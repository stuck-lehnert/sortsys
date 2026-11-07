# sortsys GAEB

Mit der eigenständigen GAEB-Editorsuite lassen sich Angebote und Aufmaße direkt
in der GAEB-Datei bearbeiten, auch mit mehreren Benutzern gleichzeitig.
Die X-Datei bleibt das bearbeitete Dokument; es entsteht kein separates
Datenbankmodell. Parsing, Canvas-Darstellung, Dezimalberechnungen und XSD-Prüfung
laufen im Browser. Die Host-Anwendung stellt versionierten Dateispeicher bereit.

```sh
cd sortsys-gaeb
bun install --frozen-lockfile
bun run dev
```

`bun run build` erzeugt eine eigenständige statische Anwendung und den
ES-Modul-Einstieg `dist/editor.js`. Änderungen werden automatisch gespeichert.
Die eigenständige Anwendung schreibt geöffnete Dateien über die File System
Access API des Browsers. Ohne diese API hält sie das Dokument in IndexedDB und
bietet einen ausdrücklichen Dateidownload an. Die sortsys-Einbindung speichert die
bestehende Projektdatei. Beim Schließen werden ausstehende Änderungen gespeichert;
eine Rückfrage erscheint nur, wenn das Speichern tatsächlich fehlschlägt.

```tsx
import { GaebEditor } from "@sortsys/gaeb";
import "@sortsys/gaeb/styles.css";

<GaebEditor
  xml={xml}
  fileName="Angebot.x84"
  locale="de"
  canEdit={canEdit}
  onSave={saveExistingFile}
  onDirtyChange={setDirty}
/>;
```

## Dateiformate

| Dateien | Bearbeitung |
| --- | --- |
| X80, X83–X87, X31, X52, X89, X93, X96 | direkt bearbeitbar |
| X81, X82, empfangene X94 und X97 | schreibgeschützt |

Namensraum und GAEB-Header bestimmen die Phase. Passt die Dateiendung nicht dazu,
erscheint ein Hinweis. Mitgeliefert werden die offiziellen GAEB-XML-3.3-LV-Schemas
von 2021-05, X31 von 2021-05 und 2023-01 sowie ältere Schemas für 3.2 und 3.1.
Version und Phase werden beim Öffnen nicht umgewandelt. Die Schema-Prüfung läuft
automatisch.

Beim Anlegen heißen die Aktionen etwa „Neues Angebot“ und „Neues Aufmaß“.
Technische Phasenkennungen stehen in Dateinamen und Schema-Diagnosen.

## Dokumentation

[Bedienung](docs/bedienung.md) erklärt Texteingabe, Gliederung, Aufmaß und Tastatur.
Die [Geschäftsabläufe](docs/ablaeufe.md) beschreiben den Weg vom Angebot zum Projekt
sowie Abrechnung und Weitervergabe. Der [technische Aufbau](docs/technik.md) richtet
sich an Entwickler und Betreiber: XML-Erhalt, Rendering, Speicherung und Zusammenarbeit.

Signierte Dateien öffnen schreibgeschützt. Besondere Preisregeln können die
Bearbeitung einschränken. Eine gültige XSD-Prüfung ist keine GAEB-/BVBS-Zertifizierung
oder vollständige kaufmännische Prüfung. Die Einzelheiten stehen unter
[Originaltreue und fachliche Grenzen](docs/technik.md#originaltreue-und-fachliche-grenzen).

## Prüfungen

```sh
bun run typecheck
bun test
bun run build
bunx playwright install chromium
bun run test:browser
```

`test:browser` baut eine eigene Aufmaß-Beispielseite. Normale Builds enthalten
keine fiktiven Prüfdokumente. Die [Testübersicht](docs/technik.md#testabdeckung)
beschreibt die Prüfungen von Editor, Host-Anwendung und API.

## Lizenz

[AGPL-3.0-only](../LICENSE). Herkunft und Prüfsummen der eingebundenen Schemas
stehen unter [GAEB-Schemas](vendor/gaeb/README.md).
