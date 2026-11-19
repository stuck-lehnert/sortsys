# Office-Dokumente und Diagramme ohne Klartextserver

Ein Betrieb soll eine Tabelle oder einen Plan im Projekt öffnen und gemeinsam
bearbeiten können, ohne dafür einen weiteren Zugang einzurichten. Die
Entschlüsselung erfolgt beim Öffnen im Browser. Beim Speichern verlassen nur
verschlüsselte Inhalte das Gerät. Die Administration verwaltet weiterhin
Benutzer und deren Rechte; eigene Schlüsselmenüs gehören nicht zum
Arbeitsablauf.

## Browsereditoren und Speicher

Klassische Dokumentserver laden Quelldateien über die API und geben bearbeitete
Dateien über einen Speichercallback zurück. Dabei verarbeiten sie Klartext.
TLS und signierte Sitzungstokens schützen den Transport und den Zugriff,
verbergen den Inhalt aber nicht vor dem Betreiber.

CryptPad verwendet angepasste Browsereditoren und einen anderen Speicher- und
Synchronisierungsweg. Der geprüfte Quellstand ist
[`86dc5ae80daa47f3b46487da9b33aeeb38846899`](https://github.com/cryptpad/cryptpad/tree/86dc5ae80daa47f3b46487da9b33aeeb38846899).
Laut dessen
[Editorhinweisen](https://github.com/cryptpad/cryptpad/blob/86dc5ae80daa47f3b46487da9b33aeeb38846899/www/common/onlyoffice/README.md)
basieren Versionen ab 9 auf EuroOffice, ältere Versionen auf ONLYOFFICE.

Die
[Installation](https://github.com/cryptpad/cryptpad/blob/86dc5ae80daa47f3b46487da9b33aeeb38846899/install-office.sh)
bindet den modifizierten Editor und `x2t` als WebAssembly ein. Der
[Konvertierungsadapter](https://github.com/cryptpad/cryptpad/blob/86dc5ae80daa47f3b46487da9b33aeeb38846899/www/common/outer/x2t.js)
schreibt Quelldaten in das Dateisystem der WASM-Laufzeit im Browser und liest
das Ergebnis dort wieder aus. Ein klassischer DocumentServer ist dafür nicht
nötig. Die
[Office-Anbindung](https://github.com/cryptpad/cryptpad/blob/86dc5ae80daa47f3b46487da9b33aeeb38846899/www/common/onlyoffice/main.js)
verschlüsselt Bearbeitungsnachrichten vor dem Versand und entschlüsselt
empfangene Nachrichten im Client. Der Server speichert und verteilt diese
verschlüsselten Nachrichten und Dateistände.

## Der Einbettungsweg für sortsys

CryptPads
[Integrationsschnittstelle](https://github.com/cryptpad/cryptpad/blob/86dc5ae80daa47f3b46487da9b33aeeb38846899/www/integration/main.js)
nimmt eine Datei als Browser-`Blob` entgegen und liefert geänderte Dateien
wieder als `Blob`. Sie enthält daneben auch Serverwege namens `ooapidl` und
`oosave`. Eine Einbettung allein garantiert deshalb noch keinen Schutz des
Klartexts.

Für sortsys gilt folgender Ablauf:

1. Der Browser lädt die verschlüsselte Datei und entschlüsselt sie mit den
   bestehenden Dateirechten. Er übergibt den Inhalt direkt an den Editor.
2. Eine neue Sitzung erhält getrennte Bearbeitungs- und Lesezugänge. Diese
   werden verschlüsselt gespeichert, bevor der Editor das Dokument öffnet. Beim
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
für seine Sandbox. So erhält ein Dokumenteditor keinen direkten Zugriff auf das
Anwendungsfenster und dessen übrige Schlüssel. Für `postMessage` werden sowohl
die genaue Origin als auch das erwartete Fenster geprüft. Die erlaubten
einbettenden Origins müssen im Betrieb auf die sortsys-Adressen beschränkt
werden.

HTTP-Dienste für Editorcode, Schriften und WASM-Dateien bleiben erforderlich.
Auch die Zusammenarbeit braucht einen Dienst für verschlüsselte Nachrichten.
Diese Dienste ersetzen den bisherigen inhaltsverarbeitenden Dokumentserver. Die
ausgelieferte Browseranwendung bleibt eine Vertrauensstelle, wie beim übrigen
Verschlüsselungsmodell.

## Diagramme

Diagramme verwenden denselben
[geschützten Dateieditor](../sortsys-webapp-v2/app/components/ProtectedOfficeEditor.tsx)
und dieselbe verschlüsselte Projektablage wie Office-Dateien. Der Editor öffnet
native `.drawio`-Dateien über CryptPads
[Diagrammanbindung](https://github.com/cryptpad/cryptpad/blob/86dc5ae80daa47f3b46487da9b33aeeb38846899/www/diagram/inner.js).
Änderungen an verschiedenen Formen werden im Browser zusammengeführt. Ein
Java-Dienst zur Verarbeitung der Dokumentinhalte ist dafür nicht nötig.

Die Anwendung speichert einen gemeinsamen Lesezugang und verschlüsselt den
Bearbeitungszugang einzeln für berechtigte Bearbeiter. Ein zusätzlicher
Quellpatch macht CryptPads nativen XML-Export über die Einbettung verfügbar.
Damit können auch Leser den gemeinsamen Stand auslesen. Ebenso lassen sich
unbestätigte Änderungen nach einem Schlüsselwechsel vor der Übernahme prüfen.
Beim Öffnen eines Diagramms mit eingebetteten Bildern entpackt der Browser
zuerst die komprimierten Seiten. Anschließend verschlüsselt er die Bilder und
lädt sie getrennt vom Diagramm hoch. Für den nativen Export entschlüsselt er
die Bilder und bettet sie wieder in die `.drawio`-Datei ein.

Der [Diensttest](../sortsys-webapp-v2/scripts/test-live-office.ts) verwendet
einen Bauablauf mit zwei Seiten. Auf beiden Seiten liegt ein PNG, eine der
Seiten ist komprimiert. Zwei getrennte Browserkontexte bearbeiten gleichzeitig
verschiedene Formen und zeigen anschließend beide Änderungen auf derselben
Seite. Der Test wechselt zur zweiten Seite und prüft auch dort die Bildanzeige.
Nach dem Schließen öffnet ein weiterer Kontext den Stand mit dem Leseschlüssel.
Sein XML-Export enthält beide Bilder bytegenau. Das gilt auch für den
exportierten Entwurf vor einem bestätigten Dateispeicherpunkt in sortsys.

Die [Komponententests](../sortsys-webapp-v2/scripts/ui/private-editors.browser.mjs)
prüfen für DOCX und Drawio den Rechteentzug, verspätete Ladeantworten und den
Wechsel zwischen Dateien einschließlich der Rückkehr zur ursprünglichen Datei.
Sie verwenden die tatsächliche React-Komponente und ein Protokoll-Testfenster.
Der Diensttest prüft dagegen die echte Zusammenarbeit. Der
[native Dateitest](../sortsys-webapp-v2/scripts/test-duckdb-editors.ts) öffnet
Office-Dateien und Diagramme über denselben Datei-Client und prüft zusätzlich
die Berechtigung zum Speichern. Diese Nachweise ersetzen einander nicht.

## Stand der Umsetzung und Prüfungen

Der Browseradapter
[cryptpadBridge.ts](../sortsys-webapp-v2/app/lib/cryptpadBridge.ts)
implementiert den Blob-Weg ohne Server-Download und Speichercallback. Er
verlangt eine eigene Editor-Origin, wartet auf die gespeicherte Sitzungsfreigabe
und weist Speicheraufrufe einer Lesesitzung ab. Browsertests prüfen diese
Grenzen auch mit Nachrichten anderer Fenster. Die normalen Projektdateidialoge
verwenden inzwischen den
[geschützten Office-Editor](../sortsys-webapp-v2/app/components/ProtectedOfficeEditor.tsx)
und die verschlüsselte Projektablage.

Der gemeinsame Lesezugang liegt in den verschlüsselten Dateimetadaten. Der
Bearbeitungszugang wird zusätzlich für die bestätigten öffentlichen Schlüssel
aller berechtigten Bearbeiter einzeln verschlüsselt. Ein Dateileser kann ihn
deshalb auch nach dem Entschlüsseln der Metadaten nicht öffnen. Die Pakete sind
an Mandant, Projekt, Datei, Sitzung sowie Regel- und Schlüsselgeneration
gebunden. Gleichzeitig begonnene Sitzungen übernehmen den bestätigten Gewinner.
Die API prüft dessen Veröffentlichung über denselben Versionsvergleich wie
andere Dateiänderungen.

Der eingebettete Editor verarbeitet den Raumzugang im Arbeitsspeicher. Die
CryptPad-Integration hält ihn aus Frame-Adressen und der Navigationshistorie
heraus. Die Webapp kann ein entferntes Editorfenster bei Bedarf aus dem
verschlüsselten Dateistand neu öffnen.

Eine geänderte Rechteversion entfernt die offenen Office-Iframes. Neue Sitzungen
beginnen mit den aktuellen Empfängern. Frühere Bearbeitungszugänge öffnen damit
keinen neuen gemeinsamen Raum. Auch beim Speichern prüft der Browser die
Sitzungskennung; alte Fenster können den aktuellen Dateistand nicht ersetzen.
Für eine Datei ohne gemeinsame Sitzung darf ein Leser eine unabhängige,
schreibgeschützte Kopie öffnen. Diese erhält keine Speicherfreigabe für das
Projekt.

Fällt die sortsys-API während einer Rechteprüfung kurz aus, bleibt der
Editor im geöffneten Tab erhalten. Der Dialog pausiert die Bedienung und
fragt die Rechte erneut ab. Erst wenn die Prüfung denselben Dateizugang
und Editorraum bestätigt, kann die Arbeit dort weitergehen. Bei der
erneuten Anmeldung am WebSocket werden versäumte Datenänderungen
abgerufen. Dazu wird ein unveränderter Sicherheitsstand anhand von
Richtlinie, Schlüsseln und aktuellem Mandantenstand erkannt. Ein Entzug
der Freigabe schließt den bisherigen Editorraum weiterhin.

Scheitert ein verschlüsselter Upload vorübergehend, fordert sortsys nach
erfolgreicher Rechteprüfung einen frischen Dateistand aus dem Editor an.
Bei weiteren Ausfällen wächst der Abstand zwischen den Versuchen. Ein
Chromium-Test unterbricht die API-Abfrage, trennt den WebSocket und lässt
anschließend einen Upload mit HTTP 503 scheitern. Nach der Wiederverbindung
enthält die bestätigte DOCX-Datei beide Änderungen aus demselben Editorfenster.

Der
[Mehrinstanztest](../sortsys-webapp-v2/scripts/test-live-file-permissions.ts)
prüft die getrennten Zugänge, einen gemeinsamen Sitzungsgewinner, die
Herabstufung auf Lesen und die Abweisung alter Speicheranfragen. Ein Browsertest
prüft zusätzlich den tatsächlichen Iframe-Wechsel im normalen Office-Dialog. Der
[native Editorlauf](../sortsys-webapp-v2/scripts/test-duckdb-editors.ts)
verwendet dafür zwei eigenständige DuckDB-APIs und eine neu eingerichtete
Organisation mit eingeladenem Mitarbeiter. Er öffnet auch die normalen Dateiadapter und prüft, dass Inhalte und Sitzungszugänge nicht
unverschlüsselt an die API gesendet werden. Nachträgliche Dateileser erhalten
denselben öffentlichen Anlagenachweis wie die ursprünglichen Teilnehmer. Dadurch
erkennen sie den gemeinsamen Raum, ohne den Bearbeitungszugang entschlüsseln zu
können.

Der [DOCX-Browsertest](../sortsys-webapp-v2/scripts/test-native-office-permissions.ts)
hält eine verschlüsselte Speicheranfrage zurück, bevor die API sie erhält. Die
zweite API-Instanz meldet die Herabstufung auf Lesen. Der schreibbare Editor
schließt, und derselbe Dateilink öffnet den bestätigten Stand zum Lesen. Die
API weist die noch wartende Speicheranfrage ab. Anschließend kann ein
berechtigtes Konto den Entwurf prüfen und ausdrücklich in einen neuen Raum
übernehmen. Der vollständige Entzug schließt auch die laufende Lesesitzung.

## Betrieb des Office-Dienstes

Der Dienst [office](../sortsys-office/README.md) baut den geprüften
CryptPad-Stand mit den festgelegten Editor- und WASM-Archiven. Er läuft ohne
Root-Rechte und mit schreibgeschütztem Dateisystem. `/tmp` enthält temporäre
Betriebsdateien; `private-office-data` enthält die verschlüsselten
Sitzungsstände. Dieser Bestand gehört zusätzlich zur Sicherung der Datenbank und
der verschlüsselten Projektdateien.

CryptPads normale Integrationsräume sind temporär. Der sortsys-Build nimmt sie
für Projektdateien von dieser Löschung aus. Der Diensttest schließt alle
Teilnehmer, startet den Dienst neu und öffnet den gemeinsamen DOCX-Stand mit dem
Leseschlüssel erneut. Ungespeicherte Exportansichten bleiben temporär.

Der gemeinsame Wiederanlauftest ersetzt den beendeten Office-Container durch
einen neuen Container mit einer Kopie des Volumes. Auch DuckDB und die beiden
API-Prozesse starten aus einem getrennten Dateisatz neu. Chromium öffnet einen
DOCX- und einen Drawio-Entwurf über die in den Projektdateien gespeicherten
Raumfreigaben. In den Editorständen stecken Änderungen, die vor dem Ausfall
noch nicht in der jeweiligen Projektdatei bestätigt waren. Der Test exportiert
und speichert beide Entwürfe und liest die bestätigten Dateien nach einem
weiteren Recovery-Wechsel über die andere API-Instanz.

`OFFICE_PUBLIC_ORIGIN` und `OFFICE_SANDBOX_ORIGIN` müssen auf Port `8080` dieses
Dienstes zeigen. `SORTSYS_PUBLIC_ORIGIN` nennt die einbettende Webapp. Alle drei
Origins müssen verschieden sein. Die CSP lässt nur diese Einbettung und die
benötigten Verbindungen zwischen den Editor-Origins zu. Nur die Office-Engine
erhält die benötigte Ausnahme für `unsafe-eval`; Diagramme und die allgemeine
Einbettung behalten die strengere Skriptrichtlinie. Der vorgeschaltete Nginx
sperrt die Klartextwege `ooapidl` und `oosave`. Compose enthält den alten
Dokumentserver nicht mehr. Das Entwicklungsskript baut denselben privaten
Office-Dienst und verwendet zwei getrennte Loopback-Origins. Die
Excel-Exportansicht übergibt erzeugte Tabellen direkt als `Blob` an den
Browsereditor. Änderungen bleiben dort bis zum Herunterladen im Browser; sie
werden nicht als Projektdatei gespeichert. Die API liefert dafür nur die
statische Editoradresse.

Die API liest die öffentliche Editoradresse aus `OFFICE_PUBLIC_ORIGIN`.
Die authentifizierte Abfrage `zerotrust.editors.config` liefert ausschließlich
diese Adresse. Dateiinhalte und Sitzungszugänge gehören nicht in diese Antwort.
Die Adresse muss eine HTTPS-Origin sein; HTTP ist nur an Loopback erlaubt.
Zugangsdaten, Queryparameter und URL-Fragmente sind ausgeschlossen.
Office-Dateien und Diagramme verwenden denselben privaten Dienst. Compose und
das Entwicklungsskript starten deshalb keinen zusätzlichen diagrams.net-Container.
Der Webapp-Nginx sperrt die früheren Editorpfade `/office` und `/drawio`.

## Noch nicht bestätigte Bearbeitungsstände

Bei einem Rechte- oder Schlüsselwechsel wird der bisherige Editorraum
geschlossen. Ein berechtigter Bearbeiter kann dessen verschlüsselten Stand über
den Leseschlüssel auslesen. Der Browser öffnet daraus eine feste,
schreibgeschützte Vorschau in einem eigenen temporären Raum. **Bearbeitungsstand
übernehmen** speichert genau diese Datei zusammen mit dem neuen Editorzugang.
Die Speicherung prüft weiterhin die Ausgangsversion und die aktuellen Rechte.
Eine inzwischen bestätigte fremde Übernahme wird dadurch nicht überschrieben.
Ältere Office-Formate werden dabei als DOCX, XLSX oder PPTX übernommen;
Diagramme behalten das native Drawio-Format. Die Vorschau verwendet bereits
den entsprechenden Dateinamen. Der gespeicherte
ursprüngliche Dateistand bleibt über die Versionshistorie erhalten.

Die Vorschau braucht eine ausdrückliche Übernahme: Frühere Schlüsselinhaber
können den alten Raum weiterhin verändern. Diese Änderungen dürfen nicht
automatisch zum gültigen Dateistand werden. Nach der Übernahme werden spätere
Änderungen im alten Raum nicht in den neuen übernommen. Leser erhalten bis dahin
den letzten bestätigten Dateistand, keinen erneut geöffneten veralteten Raum.

Ist der alte Raum nicht erreichbar, bleiben **Erneut versuchen** und
**Gespeicherten Dateistand öffnen**. Die zweite Aktion übernimmt keine dort noch
nicht bestätigten Änderungen. Ein verlorenes Office-Volume lässt sich nicht aus
dem Dateisnapshot rekonstruieren; beide gehören weiterhin zur Sicherung.

Der native Mehrinstanztest prüft die gemeinsame Speicherung, abgewiesene
veraltete Übernahmen und den Entzug von Schreibrechten. Der Test mit dem echten
Office-Dienst hält eine Dateibestätigung absichtlich offen, übernimmt den
trotzdem im Raum gespeicherten Text und prüft die Trennung des alten und neuen
Raums. Er prüft Local Storage, IndexedDB und OPFS auf Dokumentinhalte und
Editorzugänge. In Chromium umfasst die Prüfung zusätzlich die beobachteten
Frame-Navigationen und die Sitzungshistorie des Tabs. Die geprüften
Bearbeitungs- und Leseschlüssel bleiben auch beim Schließen des Iframes aus
diesen Adressen heraus.

Native Geschäftsabläufe und fein getrennte GAEB-Inhalte sind durch die
Office-Anbindung nicht erledigt.

Der eigenständige API-Router registriert keine früheren Office-Downloads oder
Speichercallbacks. Bestätigte Dateistände werden als unveränderliche
verschlüsselte Blöcke gespeichert; ein signierter Versionsvergleich schützt die
zugehörigen Dateimetadaten vor veralteten Speicheranfragen. Die Sperren
werden zusätzlich gegen die tatsächlich verwendete Nginx-Version geprüft.

Für Office wurden die festgelegten Editor- und WASM-Artefakte anhand ihrer
Prüfsummen geladen. Im lokalen Test haben zwei unabhängige Browseranmeldungen
ein DOCX über die tatsächlichen Eingabefelder bearbeitet. Die automatisch
gespeicherte Datei enthält den ursprünglichen Text und beide Änderungen. Ein
dritter Browser hat diesen gemeinsamen Stand mit dem Leseschlüssel geöffnet und
als DOCX zurückgegeben, ohne eine Speicherfreigabe zu erhalten.

Der Test verwendet auch den Upload verschlüsselter Dateiblöcke. Er untersucht
HTTP-Inhalte, Base64-dekodierte Upload-Blöcke und ausgehende WebSocket-Nachrichten
auf bekannte Testtexte und Editorzugänge. CryptPads SharedWorker werden dafür
vor ihrer ersten Anweisung über DevTools beobachtet; reine Seitenereignisse
würden deren WebSockets übersehen. Ein eigener Canary-Test sendet direkt beim
Workerstart Text und Binärdaten und gleicht den Mitschnitt mit den tatsächlich
empfangenen Bytes ab. Die Prüfung schlägt fehl, wenn kein Worker-Verkehr erfasst
wurde oder das Speicherlimit des Mitschnitts überschritten wird. Die
Klartext-Download-, Callback- und Konvertierungswege werden getrennt auf ihre
Sperre geprüft. Das ist keine vollständige Untersuchung aller Speicher- und
Netzwerkwege beliebiger Dokumente.

Bei XLSX ändert der Test eine Menge per Tastatur. Er prüft die automatische
Speicherung und das neu berechnete Ergebnis, das auch ein zweites Tabellenblatt
referenziert. Der Export enthält weiterhin die Formeln, Flächen- und
Währungsformate, einen fett gesetzten Titel, eine Kopfzeile und ein eingebettetes
PNG. Die PDF-Ausgabe verwendet den Druckpuffer des Editors und die
WASM-Konvertierung im Browser. Ein Quellpatch verbindet diesen Druckweg mit
CryptPads Integrationsschnittstelle. Der Build bricht ab, wenn die erwarteten
Stellen im festgelegten Quellstand fehlen.

Bei PPTX fügt der Test ein Textfeld in eine von sortsys erzeugte Präsentation
ein. Text und Folienformat (16:9) bleiben beim automatischen Speichern erhalten.
Für beide Formate öffnet ein zweiter Browserkontext den gleichen Raum mit
Leserechten. Er kann den neuen Stand herunterladen und löst dabei keinen
Speichervorgang aus.

Das Skript [test-office](../scripts/test-office) baut einen eigenen Testdienst,
wählt freie Loopback-Ports und führt den
[Editorlauf](../sortsys-webapp-v2/scripts/test-live-office.ts) aus.
Testcontainer und Testvolume werden auch bei Fehlern entfernt. Der vollständige
Entwicklungsstack bleibt dabei ausgeschaltet. Aufruf aus dem Repository:

```bash
CONTAINER_RUNTIME=docker ./scripts/test-office
```

Der gemeinsame DOCX-Test benötigt zusätzlich die Umgebung der nativen
API-Tests. Er startet Chromium mit dem Produktionsbuild und zwei getrennten
API-Prozessen.

```bash
TEST_OFFICE_PERMISSIONS=1 CONTAINER_RUNTIME=docker ./scripts/test-office
```

Der weitere Funktionsabgleich muss mehr Formeln und Zahlenformate,
Bildbearbeitung, komplexe Kopf- und Fußzeilen, Präsentationslayouts und
gleichzeitige Änderungen derselben Inhalte abdecken. Die Wiederverbindung
während der Bearbeitung ist bisher für DOCX geprüft. Vor der Ablösung sind die
bisherigen Klartextkopien und Caches des Dokumentservers zu berücksichtigen.
Bereits angelegte Betreiberbackups werden durch einen neuen Editor nicht
nachträglich verschlüsselt.
