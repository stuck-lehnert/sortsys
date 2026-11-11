# Office-Dokumente und Diagramme ohne Klartextserver

Ein Betrieb soll eine Tabelle oder einen Plan im Projekt öffnen und gemeinsam
bearbeiten können, ohne dafür einen weiteren Zugang einzurichten. Die
Entschlüsselung erfolgt beim Öffnen im Browser. Beim Speichern verlassen nur
verschlüsselte Inhalte das Gerät. Die Administration verwaltet weiterhin
Benutzer und deren Rechte; eigene Schlüsselmenüs gehören nicht zum Arbeitsablauf.

## Warum die bisherige Office-Anbindung ersetzt werden muss

Der vorhandene EuroOffice-Dokumentserver lädt die Quelldatei über die API. Nach
der Bearbeitung lädt die API das Ergebnis über einen Speichercallback herunter.
Der Dokumentserver verarbeitet dabei Klartext. TLS und signierte Sitzungstokens
schützen den Transport und den Zugriff, verbergen den Inhalt aber nicht vor
seinem Betreiber.

CryptPad verwendet angepasste Browsereditoren und einen anderen Speicher- und
Synchronisierungsweg. Der geprüfte Quellstand ist
[`86dc5ae80daa47f3b46487da9b33aeeb38846899`](https://github.com/cryptpad/cryptpad/tree/86dc5ae80daa47f3b46487da9b33aeeb38846899).
Laut dessen [Editorhinweisen](https://github.com/cryptpad/cryptpad/blob/86dc5ae80daa47f3b46487da9b33aeeb38846899/www/common/onlyoffice/README.md)
basieren Versionen ab 9 auf EuroOffice, ältere Versionen auf ONLYOFFICE.

Die [Installation](https://github.com/cryptpad/cryptpad/blob/86dc5ae80daa47f3b46487da9b33aeeb38846899/install-office.sh)
bindet den modifizierten Editor und `x2t` als WebAssembly ein. Der
[Konvertierungsadapter](https://github.com/cryptpad/cryptpad/blob/86dc5ae80daa47f3b46487da9b33aeeb38846899/www/common/outer/x2t.js)
schreibt Quelldaten in das Dateisystem der WASM-Laufzeit im Browser und liest das
Ergebnis dort wieder aus. Ein klassischer DocumentServer ist dafür nicht nötig.
Die [Office-Anbindung](https://github.com/cryptpad/cryptpad/blob/86dc5ae80daa47f3b46487da9b33aeeb38846899/www/common/onlyoffice/main.js)
verschlüsselt Bearbeitungsnachrichten vor dem Versand und entschlüsselt
empfangene Nachrichten im Client. Der Server speichert und verteilt diese
verschlüsselten Nachrichten und Dateistände.

## Der Einbettungsweg für sortsys

CryptPads [Integrationsschnittstelle](https://github.com/cryptpad/cryptpad/blob/86dc5ae80daa47f3b46487da9b33aeeb38846899/www/integration/main.js)
nimmt eine Datei als Browser-`Blob` entgegen und liefert geänderte Dateien wieder
als `Blob`. Sie enthält daneben auch Serverwege namens `ooapidl` und `oosave`.
Eine Einbettung allein garantiert deshalb noch keinen Schutz des Klartexts.

Für sortsys gilt folgender Ablauf:

1. Der Browser lädt die verschlüsselte Datei und entschlüsselt sie mit den
   bestehenden Dateirechten. Er übergibt den Inhalt direkt an den Editor.
2. Eine neue Sitzung erhält getrennte Bearbeitungs- und Lesezugänge. Diese werden
   verschlüsselt gespeichert, bevor der Editor das Dokument öffnet. Beim
   gleichzeitigen Öffnen verwenden alle Beteiligten die verbindlich gespeicherte
   Sitzung.
3. Die Zusammenarbeit überträgt verschlüsselte Änderungen. Beim Entzug von
   Rechten müssen auch die betroffenen Sitzungszugänge gewechselt werden. Ein
   ausgeblendeter Bearbeitungsknopf reicht dafür nicht.
4. Geänderte Dateistände kommen als `Blob` zum Browser zurück. Er bestätigt das
   Speichern erst nach der verschlüsselten Ablage in sortsys.

Eine Quelle als Server-Download-URL, ein Klartext-Speichercallback und ein
automatischer Rückfall darauf sind in diesem Ablauf ausgeschlossen. Die
Sitzungsgeheimnisse gehören weder in HTTP-Parameter noch in Protokolle.

Die Editoroberfläche benötigt eine eigene Origin, also eine eigene Kombination
aus Protokoll, Host und Port. CryptPad verwendet zusätzlich eine zweite Origin
für seine Sandbox. So erhält ein Dokumenteditor keinen
direkten Zugriff auf das Anwendungsfenster und dessen übrige Schlüssel. Für
`postMessage` werden sowohl die genaue Origin als auch das erwartete Fenster
geprüft. Die erlaubten einbettenden Origins müssen im Betrieb auf die
sortsys-Adressen beschränkt werden.

HTTP-Dienste für Editorcode, Schriften und WASM-Dateien bleiben erforderlich.
Auch die Zusammenarbeit braucht einen Dienst für verschlüsselte Nachrichten.
Diese Dienste ersetzen den bisherigen inhaltsverarbeitenden Dokumentserver.
Die ausgelieferte Browseranwendung bleibt eine Vertrauensstelle, wie beim übrigen
Verschlüsselungsmodell.

## Diagramme

draw.io kann Diagramme im Browser bearbeiten. Ein Java-Dienst zur Verarbeitung
der Dokumentinhalte ist dafür nicht erforderlich. Öffnen und Speichern verwenden
inzwischen die [verschlüsselte Projektablage](verschluesselte-projektdateien.md).
Nur die statische Editoradresse wird von der API abgerufen; XML und Dateiinhalte
werden im Browser entschlüsselt und vor dem Speichern wieder verschlüsselt.

Geprüft wurde die in Compose verwendete Version
[32.6.9](https://github.com/jgraph/drawio/tree/3e707fd20b6930778d6f6bf6e4d0079b4bce366b).
Ihr [Offline-Modus](https://github.com/jgraph/drawio/blob/3e707fd20b6930778d6f6bf6e4d0079b4bce366b/src/main/webapp/js/diagramly/EditorUi.js)
deaktiviert den entfernten Exportdienst. sortsys setzt `stealth=1` und
`lockdown=1`, deaktiviert Plugins und sperrt die Export-, Proxy- und
Cloud-Schnittstellen im vorgeschalteten Nginx. Die Editorantworten erhalten
zusätzlich eine CSP gegen externe Verbindungen, Bilder und Formularübertragungen.
Eigene Bilder müssen im Browser eingebunden werden; ein externer Bildabruf darf
keinen Ersatzweg zum Dokumentserver eröffnen.

CryptPad zeigt dafür einen konkreten Ansatz: Seine
[Diagrammanbindung](https://github.com/cryptpad/cryptpad/blob/86dc5ae80daa47f3b46487da9b33aeeb38846899/www/diagram/inner.js)
bindet den Browsereditor ein, überträgt Änderungen über das gemeinsame Framework
und führt entfernte Stände wieder zusammen. Der
[Bildadapter](https://github.com/cryptpad/cryptpad/blob/86dc5ae80daa47f3b46487da9b33aeeb38846899/www/diagram/util.js)
lädt verschlüsselte Anlagen und entschlüsselt sie im Browser. Die bisherige
sortsys-Einbettung hat diese Zusammenarbeit noch nicht.

## Stand der Umsetzung und Prüfungen

Der Browseradapter [cryptpadBridge.ts](../sortsys-webapp-v2/app/lib/cryptpadBridge.ts)
implementiert den Blob-Weg ohne Server-Download und Speichercallback. Er verlangt
eine eigene Editor-Origin, wartet auf die gespeicherte Sitzungsfreigabe und
weist Speicheraufrufe einer Lesesitzung ab. Browsertests prüfen diese Grenzen
auch mit Nachrichten anderer Fenster. Die normalen Projektdateidialoge verwenden
inzwischen den [geschützten Office-Editor](../sortsys-webapp-v2/app/components/ProtectedOfficeEditor.tsx)
und die verschlüsselte Projektablage.

Der gemeinsame Lesezugang liegt in den verschlüsselten Dateimetadaten. Der
Bearbeitungszugang wird zusätzlich für die bestätigten öffentlichen Schlüssel
aller berechtigten Bearbeiter einzeln verschlüsselt. Ein Dateileser kann ihn
deshalb auch nach dem Entschlüsseln der Metadaten nicht öffnen. Die Pakete sind
an Mandant, Projekt, Datei, Sitzung sowie Regel- und Schlüsselgeneration gebunden.
Gleichzeitig begonnene Sitzungen übernehmen den bestätigten Gewinner. Die API
prüft dessen Veröffentlichung über denselben Versionsvergleich wie andere
Dateiänderungen.

Eine geänderte Rechteversion entfernt die offenen Office-Iframes. Neue Sitzungen
beginnen mit den aktuellen Empfängern. Frühere Bearbeitungszugänge öffnen damit
keinen neuen gemeinsamen Raum. Auch beim Speichern prüft der Browser die
Sitzungskennung; alte Fenster können den aktuellen Dateistand nicht ersetzen.
Für eine Datei ohne gemeinsame Sitzung darf ein Leser eine unabhängige,
schreibgeschützte Kopie öffnen. Diese erhält keine Speicherfreigabe für das
Projekt.

Der [Mehrinstanztest](../sortsys-webapp-v2/scripts/test-live-file-permissions.ts)
prüft die getrennten Zugänge, einen gemeinsamen Sitzungsgewinner, die
Herabstufung auf Lesen und die Abweisung alter Speicheranfragen. Ein Browsertest
prüft zusätzlich den tatsächlichen Iframe-Wechsel im normalen Office-Dialog.

## Betrieb des Office-Dienstes

Der Dienst [office](../sortsys-office/README.md) baut den geprüften CryptPad-Stand
mit den festgelegten Editor- und WASM-Archiven. Er läuft ohne Root-Rechte und mit
schreibgeschütztem Dateisystem. `/tmp` enthält temporäre Betriebsdateien;
`private-office-data` enthält die verschlüsselten Sitzungsstände. Dieser Bestand
gehört zusätzlich zur Sicherung der Datenbank und der verschlüsselten
Projektdateien.

CryptPads normale Integrationsräume sind temporär. Der sortsys-Build nimmt sie
für Projektdateien von dieser Löschung aus. Der Diensttest schließt alle
Teilnehmer, startet den Dienst neu und öffnet den gemeinsamen DOCX-Stand mit
dem Leseschlüssel erneut. Ungespeicherte Exportansichten bleiben temporär.

`OFFICE_PUBLIC_ORIGIN` und `OFFICE_SANDBOX_ORIGIN` müssen auf Port `8080` dieses
Dienstes zeigen. `SORTSYS_PUBLIC_ORIGIN` nennt die einbettende Webapp. Alle drei
Origins müssen verschieden sein. Die CSP lässt nur diese Einbettung und die
benötigten Verbindungen zwischen den Editor-Origins zu. Der vorgeschaltete
Nginx sperrt die Klartextwege `ooapidl` und `oosave`. Compose enthält den alten
Dokumentserver nicht mehr. Das Entwicklungsskript baut denselben privaten
Office-Dienst und verwendet zwei getrennte Loopback-Origins. Die Excel-Exportansicht
übergibt erzeugte Tabellen direkt als `Blob` an den Browsereditor. Änderungen
bleiben dort bis zum Herunterladen im Browser; sie werden nicht als Projektdatei
gespeichert. Die API liefert dafür nur die statische Editoradresse.

## Verbleibender Funktionsabgleich

Noch offen ist das Bestätigen laufender Änderungen vor einem erzwungenen
Sitzungswechsel. Der Wechsel beginnt derzeit beim letzten bestätigten Dateistand.
Die Wiederherstellung deckt diese bestätigten Dateien ab; der Umgang mit noch
nicht als Datei bestätigten Editorständen braucht einen eigenen Vergleichstest.
Auch lokale Editor-Caches und Browserhistorie müssen vor der Freigabe abschließend
auf verbliebene Sitzungsschlüssel geprüft werden. Native Geschäftsabläufe und
fein getrennte GAEB-Inhalte sind durch die Office-Anbindung nicht erledigt.

Die API sperrt alte Office-Quellzugriffe und Speichercallbacks bereits ab Beginn
der Mandantenumstellung. Zugelassene Downloads halten die Umstellungssperre bis
zum Ende des Datenstroms. Ein Netzwerkfall prüft, dass ein abgewiesener Callback
das S3-Objekt nicht zuvor überschreibt. Die draw.io-Sperren werden gegen die
tatsächlich verwendete Nginx-Version geprüft.

Für Office wurden die festgelegten Editor- und WASM-Artefakte anhand ihrer
Prüfsummen geladen. Im lokalen Test haben zwei unabhängige Browseranmeldungen
ein DOCX über die tatsächlichen Eingabefelder bearbeitet. Die automatisch
gespeicherte Datei enthält den ursprünglichen Text und beide Änderungen.
Ein dritter Browser hat diesen gemeinsamen Stand mit dem Leseschlüssel geöffnet
und als DOCX zurückgegeben, ohne eine Speicherfreigabe zu erhalten.

Der Test verwendet auch den Upload verschlüsselter Dateiblöcke. Weder die
HTTP-Inhalte noch die Base64-dekodierten Upload-Blöcke enthielten die
Testtexte; Sitzungsgeheimnisse tauchten nicht in HTTP-URLs auf. Die
Klartext-Download-, Callback- und Konvertierungswege wurden getrennt auf ihre
Sperre geprüft. Diese Prüfung ersetzt keine vollständige Untersuchung aller
Speicher- und Netzwerkwege.

Eine erzeugte XLSX-Tabelle wurde ebenfalls im echten Editor geöffnet und wieder
ausgelesen. Der Vergleich prüft eine Multiplikationsformel samt Ergebnis,
Flächen- und Währungsformate, einen fett gesetzten Titel, eine Kopfzeile und ein
eingebettetes PNG. Die anschließende PDF-Ausgabe verwendet den Druckpuffer des
Editors und die WASM-Konvertierung im Browser. Ein Quellpatch verbindet diesen
Druckweg mit CryptPads Integrationsschnittstelle; der Build bricht ab, wenn die
erwarteten Stellen im festgelegten Quellstand fehlen.

Das Skript [test-office](../scripts/test-office) baut einen eigenen Testdienst,
wählt freie Loopback-Ports und führt den
[Editorlauf](../sortsys-webapp-v2/scripts/test-live-office.ts) aus. Testcontainer
und Testvolume werden auch bei Fehlern entfernt. Der vollständige
Entwicklungsstack bleibt dabei ausgeschaltet. Aufruf aus dem Repository:

```bash
CONTAINER_RUNTIME=docker ./scripts/test-office
```

draw.io 32.6.9 wurde zusätzlich mit der vorhandenen sortsys-Komponente aus
statischen Dateien geöffnet und über eine Tastatureingabe geändert. Der
Browser gab das geänderte XML an die Anwendung zurück. Dabei wurden keine
externen Anfragen und keine Uploads an den statischen Editorserver beobachtet.
Eine gleiche Darstellung, vollständige Formatunterstützung oder verlustfreie
Bearbeitung aller bestehenden Dateien ist damit noch nicht nachgewiesen.

Der weitere Funktionsabgleich muss mehr Formeln und Zahlenformate,
Bildbearbeitung, komplexe Kopf- und Fußzeilen, Präsentationslayouts und
gleichzeitige Änderungen derselben Inhalte abdecken. Auch die Wiederverbindung
nach einem Verbindungsabbruch während des Schreibens und der Rechteentzug vor
einem Dateispeicherpunkt sind noch zu prüfen.
Vor der Ablösung sind außerdem die bisherigen Klartextkopien und Caches des
Dokumentservers zu berücksichtigen. Bereits angelegte Betreiberbackups werden
durch einen neuen Editor nicht nachträglich verschlüsselt.
