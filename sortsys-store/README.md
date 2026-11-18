# sortsys-store

Der Datendienst hält Chiffrate und technische Mandantendaten in DuckDB. Dazu
gehören Anmeldedatensätze, öffentliche Schlüssel und Berechtigungen. Sie werden
zusammen mit den Chiffraten gesichert. Die API greift
über authentifizierte Verbindungen auf den Dienst zu; mehrere API-Instanzen öffnen
keine eigenen Kopien der Datenbankdatei.

Chiffrate bleiben unveränderlich über ihren Hash adressiert. Zusammengehörige
Metadatenänderungen werden mit Versionsprüfungen atomar gespeichert. Eine
wiederholte Anfrage mit derselben Operationskennung liefert den ursprünglichen
Beleg; dieselbe Kennung mit geändertem Inhalt wird abgelehnt. Das Änderungsjournal
enthält Verweise und technische Hinweise für den Abgleich zwischen API-Instanzen.
`POST /metadata/validate` prüft die Versionen einer zusammengestellten Leseantwort
gegen denselben Datenbankstand. Es verändert weder Datensätze noch Schreibbelege
oder das Änderungsjournal. Dadurch benötigt eine konsistente Leseabfrage keinen
Schreibvorgang.

Der Rust-Client bündelt gleichzeitig anstehende Metadatenlesezugriffe desselben
Mandanten bis zum nächsten Scheduler-Durchlauf; volle Gruppen werden sofort
versendet. Eine Gruppe enthält höchstens 32 Aufrufe und 1.024 angeforderte
Datensatzkennungen. Überschneidungen werden einmal gelesen; Reihenfolge,
Mehrfachnennungen und fehlende Datensätze bleiben in jeder Antwort erhalten.
Systemdaten und verschiedene Mandanten werden getrennt abgefragt. Abgeschlossene
Ergebnisse werden nicht zwischengespeichert. Jede API-Transaktion prüft ihre
eigenen gelesenen Versionen weiterhin vor dem Abschluss; das Bündeln macht
unabhängige Schreibvorgänge weder atomar noch geordnet.

Größere Transaktionen laden zunächst unsichtbare UTF-8-Fragmente über
`POST /metadata/prepared/part` hoch. Der Client prüft deren Inhaltsadressen und
übergibt anschließend das vollständige Manifest an
`POST /metadata/prepared/commit`. Der Dienst prüft Zielkontext, Inhalte und den
gemeinsamen Fingerabdruck, bevor derselbe atomare Speicherweg alle
Versionsbedingungen auswertet und sämtliche Änderungen veröffentlicht.
`POST /metadata/prepared/validate` prüft entsprechend große reine Lesevorgänge
ohne Schreibbeleg oder Änderungsereignis. Beide Wege benötigen dieselbe interne
Dienstauthentifizierung wie normale Metadatenzugriffe.

Transportfragmente, die seit einem Tag nicht erneut hochgeladen wurden, werden
beim nächsten Upload bereinigt. Bestätigte Operationsbelege bleiben davon unabhängig: Eine
Wiederholung kann ihren Beleg auch nach dem Entfernen der Fragmente abrufen.
Die normalen Grenzen von 1.024 Änderungen und 8 MiB bleiben bestehen; der
vorbereitete Weg verwendet die eigenen Grenzen des Frameworks.

`POST /metadata/changes` liefert den aktuellen Stand des Änderungsjournals und
höchstens 128 weitere Commits. Ohne Cursor dient die Antwort als Ausgangspunkt;
vorhandene Historie muss dabei nicht erneut übertragen werden. Mit Cursor kann
die Anfrage bis zu 25 Sekunden auf neue Commits warten. Währenddessen hält sie
keine Datenbanksperre. Erst nach dem erfolgreichen Commit werden wartende Anfragen
desselben Mandanten aufgeweckt. Nach einem Verbindungsabbruch liefert das dauerhafte
Journal alle Änderungen seit dem letzten bestätigten Cursor nach.

Das unveränderliche Journal wird über `MetadataBatch.journal` gemeinsam mit den
Datensätzen veröffentlicht. Die laufenden Nummern entstehen innerhalb dieser
Transaktion. `POST /metadata/journal/read` liest einen Eintrag anhand von Bereich
und Ereigniskennung; `POST /metadata/journal/list` liefert begrenzte Seiten nach
Bereichen und Objektpräfixen. Ein Snapshot schließt später bestätigte Einträge
von den Folgeseiten aus. Die Bereichs- und Objektindizes betreffen ausschließlich
technische Kennungen; der Dienst wertet die verschlüsselten Fachinhalte nicht aus.
Zählung und Sortierung erfolgen im Datendienst, statt den gesamten Verlauf an die
API zu übertragen. Das ist keine Zusage konstanter Abfragezeit bei beliebig großen
Journalbeständen.

Der Dienst verwendet weder PostgreSQL noch eine PostgreSQL-Kompatibilitätsschicht.
Die eigenständige API verwendet diese Schnittstellen für technische Kontodaten,
signierte Berechtigungen und Chiffratverweise. Frühere SQL-Handler gehören nicht
zum registrierten Laufzeitpfad.

## Sicherheitsstände bei einer Rücksicherung

Datensätze in `zt-anchors` erhalten einen dauerhaften Zeugen in `control.duckdb`.
Die API verankert dort die aktuelle Recovery-Generation und den maßgeblichen
Rechte- und Schlüsselstand. Beim Metadatenzugriff vergleicht der Dienst die
Mandantendatei mit diesen Zeugen. Fehlende, zurückgesetzte und widersprüchliche
Köpfe werden abgewiesen; der Dienst übernimmt sie nicht aus einer älteren Datei.
Die Zeugen enthalten keine Entschlüsselungsschlüssel.

Ein vorbereiteter Auftrag wird zuerst in der Steuerdatei gesichert. Danach
veröffentlicht eine Transaktion sämtliche Änderungen in der Mandantendatei.
Erst nach dem dauerhaften Abschluss des Zeugen liefert der Dienst Erfolg.
Unterbrechungen vor und nach dem Commit werden anhand des ursprünglichen
Operationsbelegs fortgesetzt. Ein eindeutig zurückgerollter Schreibkonflikt
entfernt seinen vorbereiteten Auftrag; ein unklarer Speicherfehler tut dies nicht.

Die Schema-Initialisierung einer geöffneten Datei wird einmal ausgeführt.
Die Zeugenprüfung bleibt bei jedem Metadatenzugriff aktiv und wird nicht als
Freigabeentscheidung zwischengespeichert.

Eine ältere Sicherung mit abweichendem Sicherheitsstand wird derzeit gesperrt.
Das automatische Ergänzen eines solchen Bestands mit dem aktuellen
Recovery-Katalog ist noch nicht umgesetzt. Auch `control.duckdb` muss gesichert
werden; ihre aktuellen Zeugen dürfen beim Rückspielen einer Mandantendatei nicht
verloren gehen. Der Mechanismus erkennt keinen vollständigen Rücksprung beider
Dateien, wenn außerhalb dieser Sicherung kein neuerer Vertrauensanker verbleibt.
Er prüft außerdem nur ausdrücklich verankerte Zustände, nicht jede fachliche Zeile.

## Betrieb

Erforderlich sind `DUCKDB_SERVICE_TOKEN` und die freigegebene DuckDB-Version samt
Quack- und HTTPFS-Erweiterung. `DUCKDB_DATA_DIRECTORY` bestimmt den Speicherort.
Der Quack-Port ist standardmäßig 9494, die interne Steuerschnittstelle nutzt 9495.
Beide gehören in das interne Datennetz. Der Browser erhält den Dienstschlüssel
nicht.

`POST /snapshots` erstellt eine neue DuckDB-Datei mit sämtlichen Tabellen des
Mandanten. Damit werden Chiffrate, Metadaten und Operationsbelege gemeinsam gesichert.
Die Datei ist eine logische Momentaufnahme; Schlüssel, die ausschließlich auf
Benutzergeräten oder in einer Recovery-Phrase liegen, werden dadurch nicht
zugänglich.

## Prüfen

Mit bereitgestellter DuckDB-Bibliothek und den festgelegten Erweiterungen:

```bash
cargo test --manifest-path sortsys-store/Cargo.toml --locked
cargo test --manifest-path sortsys-store/Cargo.toml --locked --test service -- --ignored
```

Der zweite Aufruf startet einen eigenen Dienst auf Loopback-Ports. Zwei getrennte
Clients prüfen Versionskonflikte, wiederholte Schreibanfragen, Mandantentrennung und
eine Wiederherstellung nach Dienstneustart. Alle Testdateien liegen vorübergehend
unter dem System-Tempverzeichnis. Ein laufender Entwicklungsstack wird nicht benutzt.
