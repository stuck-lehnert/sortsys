# Welche Funktionen mit verschlüsselten Daten erhalten bleiben

Prüfung des [Architekturentwurfs](verschluesselung-und-berechtigungen.md) gegen den
Quellstand vom 11. November 2026. Das ist ein Funktionsabgleich, kein Nachweis
einer fertigen Implementierung oder ihrer Geschwindigkeit.

Der zunächst naheliegende Ansatz, Daten im Browser zu verschlüsseln und die
bestehende API nur um Schlüsselpakete zu ergänzen, erhält die bisherigen
Funktionen nicht vollständig. Neben Suchabfragen und Auswertungen entfallen
verbindliche Fachprüfungen über geheime Werte. Der erste Ausbau akzeptiert diese
Grenze: Es gibt weder einen abgeschirmten Datendienst noch eine vorübergehende
Entschlüsselung durch die API. Die
[Datenprüfungen](verschluesselung-datenpruefung.md) unterscheiden deshalb zwischen
technischen Servergarantien und fachlichen Prüfungen in berechtigten Clients.

## Abgleich der Arbeitsabläufe

„Nach Umbau erreichbar“ bedeutet eine technisch begründete Aussicht auf denselben
fachlichen Ablauf. Vor Freigabe sind Vergleichstests nötig. Wo Ergebnisse,
Verfügbarkeit oder Bedienung abweichen, ist dies ausdrücklich angegeben.

| Funktion | Heutige Verarbeitung | Vorgesehener erster Ausbau und verbleibende Grenze |
| --- | --- | --- |
| Anmeldung und eigener Passwortwechsel | Passwortprüfung oder Passkey an der API | Die Passwortanmeldung richtet das persönliche Konto automatisch mit demselben Passwort ein; spätere Änderungen verschlüsseln dessen Zugang im Browser neu. Für Passkeys auf einem neuen Gerät fehlt noch die gleichwertige automatische Entsperrung. |
| Benutzer anlegen und deren Passwort zurücksetzen | Administration setzt Zugangsdaten serverseitig | Einladungen registrieren vorhandene Konten im Browser und bestätigen deren Identitäten vor der Bereichsfreigabe. Der geschützte Ablauf zum Anlegen weiterer Benutzerkonten und der Passwortverlust eines einzelnen Mitglieds brauchen noch eine eigene Anbindung. Der bisherige Admin-Reset ist für geschützte Konten gesperrt; der Anbieter erhält dadurch keinen Wiederherstellungszugang. |
| GAEB bearbeiten, D-/P-Dateien lesen, X-Dateien speichern | Browser; Dateiablage und Versionen über API | Vorhandene Projektdateien verwenden die verschlüsselte Dateiablage. Vorgangslisten, neue Entwürfe und Änderungen an Grunddaten sind angebunden; Preise, Notizen und Abrechnungsdaten haben eigene Schlüssel. Vorhandene Vorgangsdokumente werden im Browser in getrennt verschlüsselte Mengen-, Preis- und Textteile zerlegt und verlustfrei zusammengesetzt. Anlegen, Ersetzen, Öffnen, Speichern und lokale Downloads sind angeschlossen; Auftragsbestätigungen lassen sich endgültig sperren. Statuswechsel und die gemeinsame Übernahme eines angenommenen Angebots als Projekt sind angeschlossen. Bestandsaufträge aus X84–X87 und deren D-/P-Varianten lassen sich im Browser übernehmen. Für Teilfreigaben fehlen noch gesperrte Editorfelder; die Abrechnung benötigt weitere Anschlüsse. Siehe [Vorgangsadapter](verschluesselte-vorgaenge.md). Clients prüfen XML und XSD; die API kann gültig signierte Inhalte nicht fachlich zurückweisen. |
| Typst-Druck mit Bildern und PDFs | Browser/WASM | Vorlagen und Anlagenverzeichnis sind mit einem eigenen Schlüsselbereich verbunden; Originale verwenden unveränderliche verschlüsselte Dateiblöcke. Vorschau, Medienprüfung und Kompilierung bleiben im Browser. Einladungen geben die Vorlage zum Drucken frei. Siehe [Druckvorlagen](verschluesselte-druckvorlagen.md). |
| Unternehmensanschrift und Nummernschema | Mandantendaten und `global_settings` | Die vorhandenen Formulare lesen und speichern verschlüsselt. Einladungen geben die Anschrift automatisch zum Lesen frei; das Rechnungsnummernschema hat einen eigenen Schlüssel. Jede Formularansicht prüft ihren eigenen Ausgangsstand und bestätigt Änderungen erst nach erneutem Lesen. Weitere Organisationseinstellungen fehlen noch. Siehe [Organisation](verschluesselte-organisation.md). |
| Persönliche GAEB-Ansichtseinstellungen | Benutzerbezogene Klartexttabelle | Die Einstellungen werden verschlüsselt übernommen und automatisch je Konto gespeichert, unabhängig von KI-Rechten. Andere normale Benutzer erhalten keinen Zugriff. Kontowechsel verwerfen wartende Schreibvorgänge. Siehe [Ansichtseinstellungen](verschluesselte-ansichtseinstellungen.md). |
| Fein abgestufte Lese- und Schreibrechte | Rollen, teils Projektzuordnung | Getrennte Schlüssel schützen Teilinhalte; signierte Regeln begrenzen technische Schreibaktionen. Fachliche Bedingungen über Geheimwerte prüft der Client. |
| Menüs und Aktionsschaltflächen | Bisherige Rollen, Administratorvorrang | Die bereits verschlüsselten Stammdaten und Projektaktionen verwenden verifizierte Inhaltsfreigaben. Angebots- und Projektanlage bleiben getrennt; zertifizierte Anlagenachweise werden berücksichtigt. Konto- und Rechtewechsel verwerfen alte Menüstände. Weitere Fachbereiche und einzelne Editoraktionen benötigen noch Anschlüsse. Siehe [Menüs und Datenfreigaben](menues-und-datenfreigaben.md). |
| Automatisches Speichern und gemeinsame Bearbeitung | API führt Yjs-Updates zusammen und speichert XML-Stände | Produktkatalog, Kunden, Ansprechpartner, Projektgrunddaten, kaufmännische Vorgangsdaten, Dateien und KI-Verläufe erhalten technische Änderungshinweise über mehrere API-Instanzen. Geöffnete GAEB-Dateien im Projekt und im Vorgang lesen gespeicherte Stände verschlüsselt nach. Signierte Dokumentstände verhindern das Überschreiben einer zwischenzeitlich gespeicherten Version. Für einzelne Editor-Updates fehlen noch Verschlüsselung und clientseitige Zusammenführung. Ein gültig signiertes fehlerhaftes Update muss isoliert werden können. |
| Produkte einschließlich Beschreibung suchen | PostgreSQL-`tsvector` und `create_query` | Listen, Suche, Anlegen, Bearbeiten und Kategorien sind verbunden; Preisaufzeichnungen verwenden einen eigenen Schlüssel. Produktlöschung entfernt Kategorien und abhängige Preise. Der Preislistenimport veröffentlicht neue Produkte und Preise gemeinsam über vorbereitete verschlüsselte Pakete. Weitere Produktverweise in noch nicht umgestellten Fachbereichen und der vollständige Suchvergleich fehlen noch. |
| Lieferanten und Preisaufzeichnungen | SQL-Stammdaten und Preisverlauf | Lieferantensuche über Namen/Beschreibung, Anlage, Änderungen und Löschung sowie Preisänderungen und signierte Löschungen sind angeschlossen. Öffentliche signierte Beziehungen erlauben die Prüfung vorhandener Ziele und das Aufheben einer Lieferantenzuordnung ohne Preisschlüssel. Freigaben für Lieferanten und Preise bleiben getrennt. Siehe [Lieferanten und Preise](verschluesselte-lieferanten-und-preise.md). |
| Lieferscheine und Materialkosten | SQL-Lieferscheine und Auswahl historischer Preise | Bestandsübernahme, Listen, Details, Anlage, Bearbeitung und Kostenberechnung verwenden getrennte Mengen- und Beschaffungsschlüssel je Projekt. Historische Preise werden im Browser einschließlich Mikrosekunden und numerischer Kennungen ausgewählt. Anlagen sind über mehrere Instanzen nummeriert und wiederholbar; Mengenänderungen erhalten nicht lesbare Preise. Projektwechsel und vollständige Löschkaskaden fehlen noch. Siehe [Lieferscheine](verschluesselte-lieferscheine.md). |
| Kunden und Ansprechpartner | PostgreSQL-Textsuche, Formulare und Zuordnungen | Getrennte Schlüsselbereiche mit lokaler Suche, Bearbeitung und Zuordnungen sind angeschlossen. Zusätzliche gelesene Bestände werden beim Speichern technisch auf Gleichzeitigkeit geprüft. Löschung verwendet Markierungen; Projektverweise, physische Bereinigung und der vollständige Suchvergleich fehlen noch. Siehe [Kunden und Kontakte](verschluesselte-kunden-und-kontakte.md). |
| Projektgrunddaten und Projektkontakte | PostgreSQL-Textsuche, Formulare und Zuordnungen | Getrennte Bereiche je Projekt, Grunddaten, Kontaktbezeichnungen und Statuswechsel sind angeschlossen. Projektfreigaben öffnen keine Kalkulationsschlüssel. Mitarbeiter können mit begrenzter Freigabe neue Projekte anlegen; Pflichtempfänger und Recovery werden dabei berücksichtigt. Auftragswerte und die Belegung bei Weitervergaben haben unabhängige Projektbereiche. Menürollen, abhängige Fachbereiche sowie vollständige Such- und Aktivitätsparität fehlen noch. Siehe [Projektadapter](verschluesselte-projekte.md). |
| Werkzeuge, Buchungen und Inventuren | Werkzeugstammdaten, Ausgaben, Rückgaben, Umbuchungen und Inventuren über die API | Eigene verschlüsselte Bereiche je Werkzeug und Buchung; Kosten sind getrennt. Bestandsübernahme, lokale Suche, Filter, Stammdatenänderungen, Ausgabe, Rückgabe, Inventuren und Umbuchungen sind an den gemeinsamen Datenkern angeschlossen. Historische Kosten bleiben erhalten; konkurrierende Ausgaben und Umbuchungen werden atomar veröffentlicht. Automatische Mitarbeiterfreigaben, die Ausgabe ohne lesbare Kosten und die Namen aus der Personalverwaltung fehlen noch. Vollständige Textsuchparität steht ebenfalls aus. Siehe [Werkzeugverwaltung](verschluesselte-werkzeuge.md). |
| Dokumentvolltext mit Sprachen, Ranking und Ausschnitten | PostgreSQL, zuvor serverseitige PDF-Extraktion/OCR | Dateinamen und vorhandener extrahierter Text sind lokal durchsuchbar. Neue PDFs werden im Browser ausgelesen. Sprachverarbeitung, Ranking und vergleichbare Ausschnitte fehlen; ein kaltes Gerät und fehlender OCR-Text schränken Ergebnisse ein. |
| Positionsdatenbank aus bisherigen GAEB-Dateien | API liest XML und führt Klartextindex | Die Suche liest freigegebene Vorgangstexte und Projektdateien im Browser. Mengen und Preise aus Vorgängen werden dafür nicht geöffnet. Der begrenzte RAM-Index wird aus aktuellen signierten Quellen aufgebaut; Suchbegriffe bleiben lokal. Siehe [Positionssuche](verschluesselte-positionssuche.md). |
| Projektkosten, Deckungsbeiträge und historische Preise | SQL-Joins und Aggregationen | Auswertung lokal verfügbarer, lesbarer Daten; keine unveränderte zentrale Abfrage. |
| Rechnungen, Abschläge, Zahlungen und Statusübergänge | API prüft und rechnet | Clients rechnen und prüfen. Die API sichert Versionen, Rechte und öffentliche Referenzen, keine fachliche Richtigkeit geheimer Beträge. |
| Rechnungsnummern und technische Eindeutigkeit | PostgreSQL-Transaktionen und Zähler | Mit ausdrücklich sichtbaren Nummern und Projektzuordnungen erreichbar. Einzigartigkeit einer nur verschlüsselt gespeicherten Nummer ist damit nicht garantiert. |
| PDF-, DWG-, MSG- und EML-Vorschau | Überwiegend Browser | Dateiablage, Ordner und Uploads sind angeschlossen; Originale und Vorschauen werden erst im Browser entschlüsselt. PDF- und EML-Browsertests prüfen echte Darstellung und Bereinigung bei Kontowechsel. Siehe [Projektdateien](verschluesselte-projektdateien.md). |
| PDF-Text, OCR und Vorschaubilder ohne offenen Browser | Go-Jobrunner mit Klartextquellen | Kein gleichwertiger Hintergrundbetrieb. Lokale Arbeiten können mit dem Tab enden. Die LLM-/OCR-Ausnahme gilt nur für den ausdrücklich aufgerufenen Ablauf. |
| EuroOffice/ONLYOFFICE | Dokumentserver erhält Klartext und speichert per Callback | Normale Dateidialoge verwenden CryptPads Browsereditoren. Gemeinsame DOCX-Bearbeitung und Lesezugänge sind geprüft; weitere Dateifunktionen und laufende Änderungen bei Rechteentzug bleiben offen. |
| diagrams.net | Browsereditor, versionierte Dateiablage | Öffnen und Speichern verwenden die verschlüsselte Browserablage; die alte XML-API wird nicht verwendet. Verschlüsselte gemeinsame Editor-Updates fehlen noch. |
| LLM-Chat, Einlesen und MCP-Katalogsuche | Provider und authentifiziertes MCP | Chat und Einlesen verwenden Live-MCP und verschlüsselte Benutzerverläufe. Produktvorschläge werden lokal geprüft und bei Annahme zusammen mit ihrem Ausführungsnachweis gespeichert. Weitere Chat-Werkzeuge, alte Verläufe und die Übernahme in weitere Fachabläufe sind noch umzustellen. Die Klartextausnahme bleibt auf den freigegebenen Kontext der laufenden Anfrage begrenzt. |
| Laufende LLM-Anfragen beim Seitenwechsel | Chat-Anfragen überleben bereits einen internen Routenwechsel | Eine gemeinsame Laufzeitverwaltung hält Anfragen im geöffneten Tab. Beim Einlesen bleibt der nicht schließbare Dialog bis zum geprüften und verschlüsselt gespeicherten Ergebnis offen. Neue Anfragen brauchen keine serverseitigen Hintergrundjobs; alte Aufträge sind noch umzustellen. |
| Listen, zuletzt geändert und zuletzt besucht | SQL mit Namen, Beträgen und Joins | Technische Reihenfolge bleibt möglich; Bezeichnungen und Summen clientseitig entschlüsseln und zusammensetzen. |
| Eigene Client-Skripte | Worker und typisierter API-Zugriff | Adapter für geschützte Inhalte erforderlich; Zugriff nur im Rahmen der Benutzerrechte. |
| Sicherung und Wiederherstellung | Datenbank- und Dateisicherungen | Verschlüsselte Bytes und aktueller Recovery-Katalog; Entschlüsselung ausschließlich über Benutzerrechte oder Seed-Phrase. |
| Migrationen über Inhaltsfelder | SQL transformiert Klartext | Berechtigte Clients migrieren Inhalte. Servermigrationen betreffen nur öffentliche Hüllen und Referenzen. |

Die Quellprüfung umfasst insbesondere
[GAEB-Positionssuche](../sortsys-api-v2/rust-api/src/procedures/gaeb_positions.rs),
[Produktsuche](../sortsys-api-v2/rust-api/src/procedures/products.rs),
[Dokumentsuche](../sortsys-api-v2/rust-api/src/procedures/project_files.rs),
[Projektkosten](../sortsys-api-v2/rust-api/src/procedures/project_costs.rs),
[Abrechnung](../sortsys-api-v2/rust-api/src/procedures/commercial_billing.rs),
[Zusammenarbeit](../sortsys-api-v2/rust-api/src/xml_live/cluster.rs),
[Typst](../sortsys-gaeb/src/core/typstCompiler.ts),
[Dokumentserver](../sortsys-api-v2/rust-api/src/onlyoffice.rs),
[Medienverarbeitung](../sortsys-api-v2/rust-api/src/job_runner_media.rs) und
[Skriptlaufzeit](../sortsys-webapp-v2/app/lib/clientScriptRuntime.tsx).

## Office-Dokumente ohne Klartext-Dokumentserver

CryptPads [Office-Anbindung](https://github.com/cryptpad/cryptpad/blob/86dc5ae80daa47f3b46487da9b33aeeb38846899/www/integration/main.js)
nimmt eine Datei als `Blob` im Browser entgegen und meldet gespeicherte Stände
ebenfalls als `Blob` zurück. Die
[Installation der Office-Komponenten](https://github.com/cryptpad/cryptpad/blob/86dc5ae80daa47f3b46487da9b33aeeb38846899/install-office.sh)
bindet auch die WASM-Konvertierung ein. Die normalen sortsys-Dateidialoge
verwenden inzwischen diesen Weg und einen eigenen Dienst für Editorcode und
verschlüsselte Sitzungsstände.

Der neue Browseradapter verwendet ausschließlich den Blob-Weg und prüft bei
`postMessage` das Absenderfenster und die genaue Origin. Er wartet vor dem Öffnen
auf die verschlüsselt gespeicherte Sitzungsfreigabe. Der Dateiadapter bestätigt
Speichervorgänge erst nach der verschlüsselten Ablage. Ein Leser erhält keinen
Bearbeitungszugang. Zwei unabhängige Browseranmeldungen haben in einem echten
Editorlauf gemeinsam ein DOCX geändert; ein dritter Browser konnte den
gemeinsamen Stand mit dem Leseschlüssel öffnen. Nicht als Datei bestätigte
Änderungen vor Rechtewechseln, weitere Dateifunktionen und lokale Editor-Caches
bleiben zu prüfen. Die
[Quellprüfung der Office- und Diagrammeditoren](editoren-ohne-klartextserver.md)
beschreibt die geprüften Wege und bisherigen Tests.

## Volltextsuche konkret erhalten

### Produktkatalog

Die Bestandsumstellung überführt geprüfte Produktzeilen samt Kategorien und
Preisaufzeichnungen jetzt in getrennte verschlüsselte Sammlungen. Ein
Katalogleser braucht den Preisschlüssel weder anzufordern noch zu öffnen.
Umgekehrt kann eine reine Preisfreigabe Preisaufzeichnungen öffnen, ohne den
Schlüssel für Produktbeschreibungen anzufordern. Die
[Browserkomponente](../sortsys-webapp-v2/app/lib/data/products.ts) prüft die
entschlüsselten Zeilen gegen das abgeleitete Fachdatenmodell in DuckDB. Exakte
Kennungen und Zeitstempel mit Mikrosekunden bleiben bei dieser Umwandlung erhalten.

Die API liefert die verschlüsselten Objekte seitenweise. Jede Seite gehört zu
einem bestätigten Änderungsstand; Änderungen während des Abrufs erzwingen einen
Neustart. Der Leser veröffentlicht erst die vollständig geprüfte Sammlung.
Der Datendienst lädt die Ciphertexte einer Seite gemeinsam und prüft dabei
ihre Inhaltsadressen. Die API begrenzt Anzahl und Datenmenge pro Seite. Im
Browser laufen höchstens 16 Entschlüsselungen gleichzeitig; Zugriffe auf
dieselbe Schlüsselgeneration teilen sich eine bereits laufende Anfrage.
Signaturen, Mandantenbindung und Zeilenstruktur werden weiterhin für jedes
Objekt geprüft. Eine beschädigte Seite oder ein nachträglicher Kontowechsel
liefert keinen teilweise geprüften Katalog. Fehler beim Lesen des privaten JSON
enthalten keine Ausschnitte aus dem entschlüsselten Inhalt.
Zusammengehörige Schreibpakete verwenden eine gemeinsame Transaktion und
Versionsprüfung. PostgreSQL-Sperren koordinieren die beteiligten API-Instanzen;
ein Prozessspeicher-Zähler genügt dafür nicht. Diese technischen Sperren lesen
keine Produktinhalte.

Schreibanfragen nennen außerdem den vollständig geprüften Katalogstand. Zwei
reguläre Clients können dadurch nicht gleichzeitig dieselbe Artikelnummer für
verschiedene Produkte auf Grundlage eines veralteten Stands vergeben. Ein
berechtigter Client kann weiterhin absichtlich fachlich ungültige Inhalte
signieren; diese Grenze der Inhaltsprüfung bleibt bestehen.

Die lokale Suche berücksichtigt Beschreibung, Namen, Marke, Artikelnummer und
Regiebezeichnung. Wortanfänge und die Verknüpfung mehrerer Suchwörter sind
implementiert. PostgreSQLs vollständige Wortzerlegung, insbesondere bei URLs,
Bindestrichen und anderen Satzzeichen, ist damit noch nicht nachgebildet. Die
normale Produktoberfläche verwendet diesen lokalen Zugriff für Listen, Suche,
Anlegen, Bearbeiten, Kategorien und Einheitenvorschläge. Abonnierte Listen werden
nach einer lokalen Änderung aktualisiert. Der
[Ereignisabgleich](verschluesselte-synchronisierung.md) aktualisiert sie auch bei
Änderungen über eine andere API-Instanz. Nach Verbindungsabbrüchen werden
Berechtigungen und Datenstand erneut geprüft. [Einladungen](benutzerfreigaben.md)
stellen bestätigten Konten ausgewählte Katalog- und Preiszugriffe bereit.
Für diese Bereiche ist auch das Ändern bestehender Freigaben angebunden.
Änderungen am Leserkreis sperren neue Schreibvorgänge bis zum automatischen
Schlüsselwechsel. Ein unterbrochener Wechsel lässt sich bei erneutem Öffnen der
Verwaltung fortsetzen. Preisänderungen und signierte Produkt-/Lieferantenlöschungen
sind inzwischen [angeschlossen](verschluesselte-lieferanten-und-preise.md).
Weitere Fachbereiche müssen vor der vollständigen Umstellung ebenfalls integriert werden. Die alten
Klartextdaten bleiben bis dahin gesperrt vorhanden.

Der [Integrationstest](../sortsys-webapp-v2/scripts/test-live-products.ts) vergleicht
Katalog und Beschreibungstreffer mit dem bisherigen Bestand. Er prüft außerdem
einen neuen Leser nach einer Änderung, den Abbruch eines veralteten Seitenabrufs,
den Rollback eines teilweise ausgeführten Schreibpakets, konkurrierende
Schreibanfragen und getrennte Freigaben für Katalog und Preise in beiden
Richtungen. Der [Rechtetest](../sortsys-webapp-v2/scripts/test-live-permissions.ts)
prüft außerdem den Entzug mit unterbrochenem Schlüsselwechsel, neue Inhalte,
die mit dem alten Schlüssel nicht mehr lesbar sind, sowie die erneute Freigabe
mit einer verlorenen Bestätigung. Bereits bekannte
Schlüssel lassen sich nicht zurückholen; neue Preisstände benötigen nach einem
Rechteentzug eine Schlüsselrotation.

Der gemeinsame Browser-Client lässt nicht umgestellte Fachaufrufe nicht an die
alte API durch. Das gilt auch für dynamische Aufrufe und abonnierte Listen:
Ein serverseitiges Verbot allein würde nicht verhindern, dass Suchbegriffe oder
Formulareingaben bereits im HTTP-Request auftauchen. API-Antworten bleiben im
begrenzten RAM-Cache; der bisherige unverschlüsselte IndexedDB-Cache wird für neue
Antworten nicht mehr verwendet. Das Entfernen alter Browser-Caches gehört noch
zur abschließenden Bestandsumstellung.

Der [Ablauf laufender LLM-Anfragen](llm-im-browser.md) beschreibt den
Fortschrittsdialog und den flüchtigen MCP-Transport. Der Chat verwendet bereits
den geschützten Produktkatalog; weitere Fachaufrufe und Einlese-Folgeaktionen
sind noch umzustellen. Neue
Einleseergebnisse werden bereits im Client geprüft und in einem eigenen
verschlüsselten Benutzerbereich abgelegt; alte serverseitige Verläufe sind noch
zu übernehmen.

### Weitere Suchen und verbleibende Unterschiede

Die vorhandenen Suchen haben verschiedene Bedeutungen. Stamm- und Produktdaten
verwenden `create_query` mit der PostgreSQL-Konfiguration `simple`, verknüpften
Wörtern und Präfixsuche. Die Positionssuche hat ihre eigene Wortzerlegung und
Präfixabfrage. Die Dokumentvolltextsuche verknüpft deutsche und englische
`websearch_to_tsquery`-Abfragen mit einer einfachen Wortabfrage. Sie erzeugt
Ausschnitte über `ts_headline` und sortiert nach `ts_rank_cd` sowie stabilen
weiteren Kriterien. Kaufmännische Listen verwenden dagegen auch `ILIKE` über
Bezeichnung, Referenz und Kundenname.

Ein Austausch gegen ein beliebiges JavaScript-`includes` oder die ungeprüfte
Standardsuche einer anderen Datenbank wäre daher keine Funktionsgleichheit.
Auch eine korrekte Suche in nur einem bereits geladenen Ausschnitt darf nicht
als Suche über alle berechtigten Daten dargestellt werden.

Die Browser-Datenbank ist DuckDB-Wasm. Ihre Volltextsuche ersetzt die bisherige
PostgreSQL-Suche nicht unverändert: Die
[DuckDB-Erweiterung](https://duckdb.org/docs/2.0/core_extensions/full_text_search)
verwendet standardmäßig einen englischen Wortstammalgorithmus und filtert Zeichen
außerhalb von `a` bis `z`. Für deutsche Positionstexte wären diese Einstellungen
ungeeignet. Verknüpfte Präfixe, Phrasen, Ausschlüsse und deutsche beziehungsweise
englische Wortformen brauchen Vergleichstests. Auch BM25 liefert eine andere
Trefferreihenfolge als `ts_rank_cd`. Solange dieser Abgleich fehlt, besteht hier
keine nachgewiesene Funktionsgleichheit.

Bei einer Browserlösung werden Suchdaten pro Berechtigungsbereich als
verschlüsselte, versionierte Segmente abgelegt. Sie enthalten Text beziehungsweise
Indexinformationen und Ausschnitte, nicht alle PDF- oder Bildbytes. Die Segmente
sind an bestätigte Quellversionen gebunden. Ein neues Gerät lädt die für seine
Rechte nötigen Segmente und erstellt beziehungsweise öffnet daraus den lokalen
Index. Änderungen werden inkrementell übernommen; bei Rechteentzug entfernt der
vertrauenswürdige Client die betroffenen Segmente.

Dadurch muss nicht jede Originaldatei zum Endgerät übertragen werden. Trotzdem
bleiben erste Synchronisierung, Speicherplatz, Browserlimits und die Aktualität
des lokalen Stands echte Unterschiede zum bisherigen zentralen Suchdienst.
Die DuckDB-Datei wird weder in IndexedDB noch in OPFS abgelegt. Die Datenbank
bleibt im Speicher und wird aus verschlüsselten Segmenten neu aufgebaut. Ein
verschlüsselter Export allein würde nicht genügen, wenn daneben ungeschützte
Datenbankdateien lägen.

### Quack für die serverseitige Ablage

Der Dienst `duckdb` ist in beiden Compose-Dateien und in der
Entwicklungsumgebung enthalten. Er verwendet DuckDB 2.0 mit
[Quack](https://duckdb.org/docs/2.0/quack/overview). Nur dieser Dienst öffnet die
Dateien zum Schreiben. API-Instanzen verbinden sich über das interne Netzwerk;
Browser erhalten weder eine Quack-Verbindung noch das Dienstkennwort.

Jeder Mandant erhält `tenants/<technische-kennung>.duckdb`. Der Dateiname wird aus
der Mandantenkennung abgeleitet und enthält keine Firmenbezeichnung. Eine
separate `control.duckdb` gehört dem Datendienst. Die neuen verschlüsselten
Objektinhalte liegen in den Mandantendateien; PostgreSQL enthält dafür nur einen
Verweis mit dem Hash des verschlüsselten Pakets. Ein Paket wird zuerst dauerhaft
gespeichert, bevor der API-Vorgang seinen Verweis veröffentlicht. Nicht mehr
referenzierte Pakete können bei abgebrochenen Vorgängen zurückbleiben.

Dieser Schritt ersetzt PostgreSQL noch nicht vollständig. Dort liegen weiterhin
Anmeldung, Berechtigungs- und Recovery-Metadaten, Revisionen sowie die alten
Fachdaten bis zur abgeschlossenen Umstellung. Eine einzelne DuckDB-Datei ist
**noch keine vollständige Mandantensicherung**. Die bestehenden
PostgreSQL-Sicherungsrouten sichern umgekehrt keine neuen DuckDB-Inhalte.
Sicherung und Wiederherstellung müssen diese Bestände gemeinsam erfassen, bis
die übrigen Daten umgestellt sind; Dateien im Objektspeicher gehören ebenfalls
dazu.

Der interne Snapshot-Aufruf erstellt mit `COPY FROM DATABASE` eine eigene
DuckDB-Datei und schließt sie vor der Veröffentlichung. Erst nach dem
Synchronisieren und atomaren Umbenennen lässt sich diese Datei herunterladen.
Sie kann unabhängig vom laufenden Dienst geöffnet werden. Ein beliebiges
Kopieren der aktiven Datei wäre unsicher: Bestätigte Änderungen können noch im
[Write-ahead-Log](https://duckdb.org/docs/2.0/operations_manual/footprint_of_duckdb/files_created_by_duckdb)
liegen, und während des Kopierens könnten weitere Änderungen eintreffen. Der
aktuelle Recovery-Stand muss auch nach der Wiederherstellung einer älteren
Sicherung verhindern, dass eine bereits verbrauchte Phrase wieder gültig wird.

Quack stellt eine [SQL-Oberfläche](https://duckdb.org/docs/2.0/quack/security)
bereit. Der Dienst ist deshalb ausschließlich über das interne Datennetz
zugänglich und verlangt ein Dienstkennwort. Die API prüft weiterhin
Mandantenzugehörigkeit und Berechtigungen. In DuckDB werden die unveränderlichen
verschlüsselten Pakete über ihren Hash adressiert; ihre Klartexte oder
Entschlüsselungsschlüssel werden dort nicht benötigt.

Die Rust-Anbindung nutzt direkte C-API-Abfragen: Vorbereitete Anweisungen der
Rust-Bibliothek funktionieren derzeit nicht durchgängig mit `CONNECT`.
Konkurrierende Schreibtransaktionen werden begrenzt mit einer neuen Verbindung
wiederholt. Revisionen und Rechtewechsel koordiniert bisher weiterhin
PostgreSQL. Für deren vollständige Verlagerung nach DuckDB fehlen noch die
entsprechenden Versionswächter. Quack liefert außerdem keine
Änderungsbenachrichtigungen; die Zusammenarbeit braucht weiterhin einen
instanzübergreifenden Transport.

Konfiguration und der Umfang der Netzwerkprüfungen stehen in der
[Anleitung zum Datendienst](../sortsys-api-v2/rust-api/duckdb/README.md).

Sofortige vollständige Ergebnisse auf einem neuen Gerät werden im ersten Ausbau
nicht zugesagt. Es gibt keinen privaten Suchdienst mit einer bereits vollständigen
Indexkopie. Die Oberfläche muss den Synchronisierungsstand erkennbar machen und
unvollständige Ergebnisse entsprechend kennzeichnen.

Ein Bereich mit Preisen darf keine Suchbegriffe oder Ausschnitte in einen weiter
lesbaren Leistungsindex einschleusen. Dasselbe gilt für Dateinamen, Trefferzahlen
und einen öffentlichen SHA-256-Fingerabdruck bekannter Positionstexte. Die
vorhandenen Klartextindizes werden entfernt, sobald ihre geschützten Ersatzwege
vollständig sind. Blindindizes sind keine vorausgesetzte Abkürzung: Sie verändern
Suchmöglichkeiten und offenbaren Gleichheiten beziehungsweise Suchmuster.

Die lokale Suchkomponente führt
Textabgleich, Rechteprüfung und Pagination aus. Die Auswahloberfläche filtert
ihre Ergebnisse nicht nochmals nach dem Anzeigenamen.

## Vergleichsfälle und Freigabekriterien

Suchtests verwenden dieselben erlaubten Quellstände im heutigen PostgreSQL und
im vorgesehenen privaten Suchweg. Verglichen werden Treffer, Reihenfolge,
Ausschnitte, Pagination und erkennbare Unvollständigkeit des Indexstands. Nötig
sind unter anderem:

- Ein Produkt wird ausschließlich über ein Wort in seiner Beschreibung gefunden;
  Namen und Artikelnummer enthalten das Wort nicht.
- Mehrere Suchwörter, Präfixe und Artikelnummern mit Satzzeichen behalten die
  bisherige Bedeutung. Umlaute, `ß`, Bindestriche, unterschiedliche Schreibweisen
  und sehr kurze Suchwörter werden gezielt verglichen.
- Deutsche und englische Dokumenttexte, zitierte Wortfolgen und Ausschlüsse
  liefern dieselben zulässigen Treffer. Abweichende Wortstämme oder Ausschnitte
  werden nicht als bloß kosmetische Unterschiede abgetan.
- Ein Benutzer mit Teilrechten findet keine Treffer oder Ausschnitte aus
  verborgenen Preisen, Nachunterlagen oder fremden Projekten. Das gilt auch,
  wenn eine Suchanfrage Wörter aus mehreren Inhaltsbereichen kombiniert.
- Ein neues Gerät, ein gelöschter Browsercache und unterbrochene Synchronisierung
  erzeugen keine irreführend vollständige leere Ergebnisliste.
- Ein neuer PDF-Upload erhält Text und OCR-Ergebnisse einschließlich Aktualisierung
  des Index. Fehler, Wiederholungen und veraltete Ergebnisse nach einem
  Dateiwechsel werden korrekt behandelt.

Für Kosten und Rechnungen werden dieselben Eingaben einschließlich Dezimalstellen,
historischer Preise, Nachlässe, Steuer, Rundung und Abschlagsketten verglichen.
Gleichzeitige Änderungen benötigen aktuelle Versionen und gültige Schreibrechte.
Ungültige Felder, falsch typisierte Werte und manipulierte CRDT-Pakete gehören
zu den Negativfällen: Der berechtigte Client darf sie nicht ungeprüft anwenden.
Die API kann ihre fachliche Ungültigkeit nicht erkennen.

Neben dem Ergebnis zählt der Arbeitsablauf: neue Anmeldung, erster Suchzugriff,
warmer Suchzugriff, schneller Text, gleichzeitige Bearbeitung und unterbrochene
Synchronisierung werden auf schwächeren Geräten gemessen. Die
zusätzlichen Kosten für Arbeitsspeicher, Indexspeicher und Datentransfer werden
mit erfasst. Dieser Entwurf enthält dafür keine erfundenen Leistungswerte.

## Noch nicht gleichwertig zugesagte Funktionen

Der reine Browseransatz hat weiterhin keine vollständige serverseitige
Inhaltsprüfung und keine unabhängig von Endgeräten verfügbare Suche oder OCR.
Diese Einschränkungen werden für den ersten Ausbau bewusst akzeptiert. Es gibt
keinen stillschweigenden Ersatz durch einen Dienst mit Entschlüsselungsschlüsseln.

Die vorhandene EuroOffice-/ONLYOFFICE-Anbindung ist ohne eigenen Umbau keine
clientseitige Datenverarbeitung. Gleiches gilt für Poppler, Tesseract und
ImageMagick im bisherigen Jobrunner. Die bereits akzeptierte LLM-Ausnahme wird
nicht automatisch auf diese Dienste ausgeweitet.

Damit ist fachliche Gleichwertigkeit für viele Arbeitsabläufe erreichbar, aber
weder eine unveränderte Gesamtarchitektur noch vollständige Funktions- und
Performancegleichheit nachgewiesen. Ein produktiver Wechsel darf erst für die
jeweils geprüften Bereiche erfolgen.
