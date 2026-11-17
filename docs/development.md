# Lokale Entwicklung

`./scripts/dev` startet den gemeinsamen DuckDB-Datendienst, API und Webapp. Der
Office-Dienst und diagrams.net starten unabhängig davon. Das neue Setup
verwendet keine laufende PostgreSQL-Installation. Alte Bestände werden
[beim Anlegen eines Mandanten aus einer Sicherung übernommen](bestandsumstellung.md).

| Dienst         | Standardadresse          |
| -------------- | ------------------------ |
| Webapp         | <http://127.0.0.1:5173>  |
| API            | <http://127.0.0.1:3000>  |
| Office         | <http://127.0.0.1:39180> |
| Office-Sandbox | <http://127.0.0.1:39182> |
| diagrams.net   | <http://127.0.0.1:39181> |

Ports und Images lassen sich über die `DEV_*`-Variablen am Anfang von
[`scripts/dev`](../scripts/dev) anpassen. `CONTAINER_RUNTIME=docker` oder
`CONTAINER_RUNTIME=podman` wählt das Werkzeug ausdrücklich. Ohne Vorgabe wird
Podman verwendet, falls es vorhanden ist, andernfalls Docker. Auch mit
macOS-Bash muss der Start funktionieren.

## Daten und Protokolle

Der Stack verwendet eigene Namen mit dem Präfix `sortsys-dev-zt`. Die Dateien
und Abhängigkeiten liegen unter `.dev-data/zerotrust/`. Ein Neustart erhält die
Mandantendateien. Der geseedete Bestand liegt in `seeded-duckdb/`; bereits
vorhandene Dateien in `duckdb/` werden nicht verändert. Das vermeidet eine
Kollision mit einem zuvor manuell eingerichteten Mandanten namens `test`.
`DEV_DATA_DIR` und `DEV_STACK_NAME` erlauben einen getrennten zweiten Stack;
dafür müssen auch die Ports angepasst werden.

Beim ersten Start wird der Mandant `test` eingerichtet. `john.doe@test` hat
Administratorrechte, `frank.doe@test` keine besonderen Berechtigungen. Beide
Konten verwenden das Passwort `123456`. Die Unternehmensanschrift, Kunden,
Produkte mit Preisen und Werkzeuge sind bereits angelegt. Angebote liegen als
Anfrage, Entwurf, versendet, angenommen, abgelehnt und zurückgezogen vor. Aus
angenommenen Angeboten sind Projekte entstanden. Dort lassen sich Nachträge,
Nebenangebote, Weitervergaben und Preisanfragen in verschiedenen
Bearbeitungsständen öffnen. Aufmaße enthalten Maßansätze mit
Zwischenüberschriften und Öffnungsabzügen. Die Rechnungsbeispiele zeigen
leistungsbezogene und pauschale Abschläge samt Zahlungen, die anschließende
Schlussrechnung sowie Einzelrechnungen für Aufträge ohne Abschläge. Die Vorgänge
verwenden native GAEB-Dateien mit verknüpften Ausgangsdokumenten. Zum
Hauptprojekt gehören außerdem
[feste Plan- und E-Mail-Beispiele](../sortsys-api-v2/seed-assets/README.md).

Die Befüllung läuft als lokaler Client mit derselben Verschlüsselung und
denselben Freigabeprüfungen wie die Webapp. Die API erhält keine privaten
Schlüssel. `seed/progress.json` unterhalb von `DEV_DATA_DIR` hält den
Fortschritt fest; ein Neustart erhält eigene Änderungen. Ergänzungen des
Musterbestands werden einmalig hinzugefügt. Die nur für diesen
Entwicklungsbestand erzeugte Recovery-Phrase liegt in `seed/recovery-phrase.txt`
und wird nicht an die API übermittelt. Der erste Aufbau dauert länger als ein
normaler Neustart.

Die Betreiberverwaltung verwendet ebenfalls das Passwort `123456`. Bei einer
eigenen Vorgabe müssen `DEV_ADMIN_PASSWORD` und `DEV_ADMIN_HASH` zusammenpassen.
Weitere Mandanten werden über einen einmaligen Link eingerichtet. Der erste
Benutzer erhält Administratorrechte. Erst ein signierter Abschluss der
Grundeinrichtung gibt die Fachseiten frei; nach einem Abbruch lässt sich die
Einrichtung fortsetzen.

`Ctrl+C` beendet die gestarteten Container. Protokolle zeigt beispielsweise
`docker logs -f sortsys-dev-zt-api`. Bei fehlgeschlagenem API-Start bleiben der
Container und `.dev-data/zerotrust/logs/api-startup.log` zur Diagnose erhalten.
Nicht verfügbare Editoren beenden die Kernanwendung nicht. Der Office-Dienst
verwendet zwei getrennte Origins für Editor und Sandbox.

Die native Live-LLM-Anbindung verwendet authentifiziertes MCP, auch wenn
WebSocket und Werkzeugaufruf verschiedene API-Instanzen erreichen. Die noch
offenen Punkte stehen im
[Funktionsabgleich](verschluesselung-funktionsabgleich.md).

## Native Tests ohne Entwicklungsstack

```bash
./scripts/test-api
```

Docker oder Podman stellt dafür die festgelegten Werkzeuge bereit. Ein eigener
Container erhält eine Kopie der Quellen ohne lokale Zugangsdaten und prüft die
Rust-Pakete, den TypeScript-Client, den Vertrag und die nativen Abläufe. Er
startet seine Dienste selbst, veröffentlicht keine Ports und wird nach dem Lauf
entfernt. Die Cargo-Verzeichnisse werden wiederverwendet; Testdaten und Prozesse
sind für jeden Lauf neu. `TEST_LOG_DIR` bestimmt den Ablageort der Protokolle.

Wer Rust, Bun und DuckDB bereits installiert hat, kann die native Integration
direkt prüfen:

```bash
./scripts/test-native-auth
```

Mit Rust, Bun, der festgelegten DuckDB-Bibliothek und ihren Erweiterungen
startet die Suite für jeden ausgewählten Test einen eigenen DuckDB-Prozess mit
frischen Mandantendateien. Die unabhängigen API-Instanzen innerhalb eines Tests
teilen sich diesen Datenspeicher und verwenden Loopback-Ports. Bereits belegte
Mandantennamen oder geänderte Betreibereinstellungen aus einem anderen Test
beeinflussen den nächsten Test dadurch nicht. Die Suite verwendet den
Kryptografie- und Datenadaptercode der Webapp. Anmeldung, verschlüsselter Kontospeicher,
Passwortwechsel und Sitzungsentzug werden ohne PostgreSQL geprüft.

Der ausgegebene Protokollordner enthält pro Test ein Unterverzeichnis mit
`store.log`, `tests.log` und `cleanup.json`. `results.json` ordnet diese
Verzeichnisse den Testnamen zu und enthält Ergebnis und Laufzeit. Die
DuckDB-Dateien erfolgreicher Tests werden nach dem Beenden der Dienste entfernt;
bei einem Fehler bleiben sie zur Untersuchung erhalten. Nach einem fehlgeschlagenen Test laufen die
übrigen Fälle weiter, sofern dessen Dienste vollständig beendet wurden.

Die Suite richtet außerdem einen neuen Mandanten über den einmaligen
Einrichtungslink ein. Sie prüft öffentliche Schlüssel und Rechte, gemeinsame
Objektänderungen, Katalogreferenzen und endgültig gesperrte Dokumentstände.
Tagesberichte und Regieberichte werden über beide API-Instanzen angelegt und
bearbeitet. Der Fachablauf prüft genaue Stunden und Mengen, erhaltene
Zeilenkennungen und interne Stundensätze sowie atomare Baustellenwechsel in der
Einsatzplanung. Veraltete Formulare und vorgetäuschter Speichererfolg werden
abgewiesen; eine verlorene Bestätigung darf keine zweite Anlage erzeugen. Der
Änderungsverlauf wird mit unveränderlichen Seiten, wiederholten Anfragen und der
echten Aktivitätenansicht geprüft. OpenTimestamps-Aufträge werden konkurrierend
reserviert und nach Ablauf durch eine neue Browser-Sitzung übernommen.
Vorhandene Belege müssen bei einem erfolglosen Folgeversuch erhalten bleiben.
Drei WebSocket-Verbindungen prüfen Änderungen über beide API-Instanzen sowie den
sofortigen Rechte- und Sitzungsentzug.

`DUCKDB_LIB_DIR`, `DUCKDB_INCLUDE_DIR` und `DUCKDB_EXTENSION_DIRECTORY` wählen
die benötigten Bibliotheken. Der Systemloader muss die DuckDB-Laufzeitbibliothek
finden; `SORTSYS_NATIVE_BUN` kann einen abweichenden Bun-Pfad angeben. Der Test
verwendet öffentliche Testvektoren und eigene temporäre Dateien. Ein
Entwicklungsstack oder eine PostgreSQL-Instanz werden nicht angesprochen.
Protokolle und das Ergebnis der Dienstbereinigung bleiben unter dem ausgegebenen
Tempverzeichnis erhalten.

## Browser-E2E mit echten Diensten

Nach `bun run build` in `sortsys-webapp-v2` führt
`TEST_NATIVE_BROWSER=1 ./scripts/test-api` die native Suite samt
Chromium-Prüfung der gebauten Anwendung aus. Die CI verwendet diesen Aufruf
ebenfalls. Der Browser arbeitet gegen die echten API-Router und den isolierten
DuckDB-Dienst; Fachadapter werden nicht ersetzt.

Geprüft werden unter anderem abgewiesene Anmeldungen, sichtbare
Admin-Funktionen, das Speichern und erneute Laden der Unternehmensanschrift,
Beispieldaten und der Dokumentdialog. Aufmaß, Preisanfrage und Schlussrechnung
werden auch über die Projektübersicht und direkte Dokumentlinks geöffnet. Ein
normales Konto darf die Admin-Tabs, fremde Vorgänge und Projektanhänge auch über
direkte Links nicht öffnen. Der Seed-Test prüft zusätzlich verweigerte
Schreibzugriffe und den Erhalt manueller Änderungen beim zweiten Start. Zwei
gleichzeitig angemeldete Konten an getrennten API-Instanzen prüfen die Freigabe
und den Entzug des Produktkatalogs: Inhalte und Navigation müssen sich ohne
Neuladen aktualisieren. Geschäfts-Klartext darf in den geprüften API-Anfragen
nicht vorkommen. Im Abwesenheitsablauf setzt die Administration den
Standardvorgesetzten, lädt dessen Auswahl erneut und verfolgt einen zunächst
offenen Abwesenheitsantrag bis zur Freigabe über die zweite API-Instanz. Beide
Browser werden auf unbehandelte Fehler, unimplementierte Clientaufrufe und die
Übertragung der geprüften Klartexte kontrolliert. Die OpenTimestamps-Kalender
antworten in diesem Test gezielt mit 503; Antrag und Genehmigung müssen trotzdem
gespeichert werden. Die [Betreiberdiagnose](technische-fehlerberichte.md) wird
nach einer verweigerten Dokumentabfrage ebenfalls über die tatsächliche
Oberfläche geprüft. Der Betreiber erstellt eine
[verschlüsselte Mandantensicherung](verschluesselte-sicherungen.md), lädt sie
herunter und findet sie nach einem Neuladen wieder. Ein nativer Mehrinstanztest
prüft zusätzlich, dass eine verlorene Antwort keine zweite Sicherungsdatei für
denselben Auftrag erzeugt. Screenshots, Playwright-Traces und bei Fehlern der
HTML-Stand liegen im Unterverzeichnis `browser-artifacts` der gesicherten
Testprotokolle.

Bei lokal installierten Werkzeugen und bereits installiertem Chromium lässt sich
gezielt dieser Ablauf ausführen:

```bash
SORTSYS_NATIVE_BROWSER=1 \
SORTSYS_NATIVE_AUTH_TEST_FILTER=zerotrust::opaque::store_tests::development_seed_creates_ready_accounts_and_preserves_manual_edits \
./scripts/test-native-auth
```

`SORTSYS_E2E_HEADED=1` öffnet dabei ein sichtbares Browserfenster, sofern ein
Desktop verfügbar ist. `bunx playwright show-trace <pfad-zur-trace.zip>` öffnet
die Aufzeichnung eines einzelnen Szenarios.

Für eine erneute Browserprüfung kann zusätzlich
`SORTSYS_NATIVE_BROWSER_FIXTURE=<Fallverzeichnis>` auf die erhaltenen Daten eines
fehlgeschlagenen Entwicklungstenant-Tests zeigen. Dafür müssen dessen
Seed-Prüfungen bestanden und die Dienste beendet sein. Der Starter kopiert die
kalten DuckDB-Dateien in ein neues Testverzeichnis; die Quelldateien bleiben
erhalten. Der Modus benötigt den oben gezeigten genauen Testfilter und
`SORTSYS_NATIVE_BROWSER=1`. Er wiederholt ausschließlich die Browserfälle und
erspart die erneute Datenerzeugung. In `results.json` ist er als
`browser-replay` gekennzeichnet.
`SORTSYS_E2E_SCENARIO` wählt bei Bedarf einzelne Browserfälle über ihre Namen
aus; mehrere Namen werden durch Kommas getrennt. Unbekannte Namen lassen den
Lauf fehlschlagen.

Der [Datendienst](../sortsys-store/README.md#prüfen) hat eigene
Netzwerkprüfungen für wiederholte Schreibanfragen, wartende Änderungsabfragen
und die Wiederherstellung aus einer Mandantendatei. Kalenderantworten im
API-Test sind synthetisch; weder echte Kalender noch ein LLM-Anbieter werden
kontaktiert.

Die Tests verwenden denselben nativen Router wie der Serverstart. Weitere Fälle
prüfen Einladungen, getrennte Benutzerrechte, Abwesenheitsentscheidungen und
zwei aufeinanderfolgende Recoveries. Die Ersteinrichtung wird mit einem Abbruch
vor den Grunddaten sowie einer verlorenen Abschlussantwort geprüft.
Browser-Tests zeigen, dass direkte Links zu Fachseiten vor dem signierten
Abschluss gesperrt bleiben. Ein eigener Starttest prüft, dass alte
Klartext-Endpunkte nicht registriert sind. Diese Nachweise ersetzen noch keinen
vollständigen Fachablauf. Den aktuellen Umfang beschreibt der
[Funktionsabgleich](verschluesselung-funktionsabgleich.md).
