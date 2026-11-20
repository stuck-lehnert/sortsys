# Dokumente finden

Unter **Dokumente** lassen sich Dateinamen und ausgelesene Texte aus freigegebenen
Projektanhängen gemeinsam durchsuchen. So findet etwa `Wand Fenster` einen
Ausführungsplan, in dem „Wände“ und „Fenster“ vorkommen. Die Suche berücksichtigt
deutsche und englische Wortformen sowie Wortanfänge. Alle eingegebenen Wörter
müssen vorkommen, sofern sie nicht mit `OR` getrennt werden.

| Eingabe | Ergebnis |
| --- | --- |
| `Fenst Abdicht` | Beide Wortanfänge kommen im Dateinamen oder Text vor. |
| `"rote Fenster"` | Die Wörter stehen in dieser Reihenfolge unmittelbar nebeneinander. Wortformen werden berücksichtigt. |
| `Fenster OR Türen` | Mindestens einer der Begriffe kommt vor. |
| `Fenster -Asbest` | Fenster kommen vor; Asbest wird ausgeschlossen. |
| `"Fenster ausbauen" OR Fassade -Asbest` | Entweder passt die Phrase, oder Fassade kommt ohne Asbest vor. |

Dateinamentreffer erhalten ein höheres Gewicht. Im Dokumenttext werden nahe
beieinanderliegende Suchwörter bevorzugt; häufige Wiederholungen erhöhen die
Bewertung nur begrenzt. Bei gleicher Bewertung entscheiden Änderungsdatum und
Kennung. Bei einer `OR`-Suche bestimmen die vollständig passenden Alternativen
den Rang. Der Ausschnitt zeigt die am besten passende Stelle im Dokumenttext
und hebt die Wörter der gewählten Alternative hervor. Ein Treffer allein im
Dateinamen erscheint ohne Textausschnitt. HTML und andere Zeichen aus dem
Dokument bleiben gewöhnlicher Text.

## Durchsuchbare Inhalte

Beim Hochladen und beim Speichern einer neuen Version liest der Browser den
eingebetteten Text von PDFs aus. Bei Word-Dateien (`DOCX`) erfasst er den
Dokumenttext, bei PowerPoint-Dateien (`PPTX`) den Folientext. In Excel-Dateien
(`XLSX`) liest er gespeicherte Zellwerte. `TXT` und `CSV` sind bei UTF-8-Kodierung
ebenfalls durchsuchbar.

Bei E-Mails im Format `EML` oder `MSG` erfasst der Browser Betreff, Absender,
Empfänger und Nachrichtentext. So lässt sich eine Materialfreigabe auch finden,
wenn die Projektdatei nur „E-Mail.msg“ heißt. Externe Bilder werden nicht
geladen. Inhalte eingebetteter Anhänge
sind durchsuchbar, wenn diese Dateien separat als Projektanhänge abgelegt
werden und ein unterstütztes Textformat haben.

Der Browser verschlüsselt den Text mit den Metadaten der zugehörigen Version.
Nach dem Speichern einer neuen Fassung zeigt die Suche nur deren Text. Scans
ohne Textschicht, ältere Dateien ohne ausgelesenen Text und Dateien, deren
Inhalt sich nicht auslesen lässt, bleiben über den Dateinamen auffindbar. Eine
Texterkennung über ein LLM gehört zum ausdrücklich gestarteten Ablauf
**Einlesen**.

Eine Dateifreigabe öffnet keine Projektstammdaten. Fehlt deren Leserecht, erscheint
der Treffer ohne Projektbezeichnung. Ein Klick auf den Treffer öffnet die Datei
in der eingeschränkten Ansicht **Projektanhänge**. Dateien aus nicht
freigegebenen Bereichen liefern weder Treffer noch Ausschnitte.

Die API erhält verschlüsselte Datensätze und technische Kennungen. Suchbegriffe,
Dateinamen und Ausschnitte bleiben im Client. Die Seite hält die Suchanfrage
im Arbeitsspeicher. Nach dem Neuladen beginnt die Suche mit einem leeren Feld.
Bei der Suche in einem Projekt fordert der Browser den Berechtigungsnachweis
und die erste Dateiseite zusammen an.
Die Suche über mehrere Projekte lädt Dateisammlungen gebündelt. Treffen
Anfragen für Folgeseiten gleichzeitig ein, verarbeitet die API sie ebenfalls
in einem Sammelabruf. Für jede Seite prüft sie den Stand der zugehörigen
Sammlung. Bei einer Folgesuche kann die API bis zu 16 Sammlungsabfragen im
selben Schritt wie den bereits bekannten Berechtigungsstand prüfen. Hat sich
dieser geändert, erhält der Browser zuerst das aktuelle Verzeichnis der
Bereiche und wählt die Abfragen neu aus. DuckDB prüft die Dateidaten und
Ordnerbeziehungen in einer lokalen Transaktion. Der Browser verwendet dieselbe
DuckDB-Instanz für weitere Prüfungen und rollt die Prüfdaten nach jeder
Transaktion zurück.
Ein Wechsel der Freigaberichtlinie oder das Sitzungsende schließt die Instanz.

Die Textauswertung läuft in einem eigenen Worker. Er hält Textblöcke,
Wortformen und Textpositionen des geprüften Bestands in einem begrenzten
Arbeitsspeicher. Beim Ändern der Suchbegriffe verwendet er bereits
übertragene Blöcke weiter. Größere Bestände werden ebenfalls vollständig
durchsucht. Ihre übrigen Blöcke werden bei jeder Suche erneut an den Worker
übertragen. Eine neue Suchanfrage stoppt die alte nach dem laufenden Block.
Ändert sich die Dateiauswahl, eine Freigabe oder eine Dateiversion, verwirft
der Browser den bisherigen Bestand. Das gilt auch am Ende der Sitzung.

Der Browser liest die Projektbezeichnungen gebündelt für die angezeigten
Treffer. Vor der Ausgabe prüft er die Freigaben und Stände aller
durchsuchten Dateisammlungen erneut. Auch diese abschließende Prüfung lässt
sich mit dem Berechtigungsabruf verbinden.
Wird eine Datei während der Suche geändert oder gelöscht, wertet der Browser
den neuen Stand aus. Fortlaufende Änderungen können den Abruf mit einem
Hinweis auf die geänderten Daten beenden.

Auf einem neuen Gerät müssen zunächst alle freigegebenen Suchdaten geladen
werden. Originaldateien werden dafür nicht erneut heruntergeladen. Die
entschlüsselten Suchdaten liegen im Arbeitsspeicher, nicht in einer dauerhaften
Browserdatenbank.

## Vergleich mit der bisherigen Suche

Die Wortstammverarbeitung verwendet die deutschen und englischen Algorithmen aus
[@orama/stemmers](https://github.com/oramasearch/orama/tree/main/packages/stemmers).
Die Suchsyntax orientiert sich an
[PostgreSQLs Websuche](https://www.postgresql.org/docs/current/textsearch-controls.html#TEXTSEARCH-PARSING-QUERIES).
Ein Vergleich mit acht Beispieldateien und 28 Suchanfragen hat die frühere
Abfrage unter PostgreSQL 18.6 in PGlite nachgestellt. Bei 16 Abfragen stimmten
die Treffer überein, bei 14 auch ihre Reihenfolge. Beide Suchen fanden deutsche
und englische Wortformen. Die Browsersuche fand bei `Fenst` zusätzlich einen
Treffer in einer URL. Bei `"rote Fenster"` verlangte sie benachbarte Wörter.
Die frühere Abfrage lieferte auch „rote alte Fenster“. Bei `Fenster -Asbest`
schloss die Browsersuche ein Dokument mit „Asbestplatten“ aus, das in den
früheren Ergebnissen enthalten war. Für reale Mandantenbestände und die Qualität
der Ausschnitte steht der Vergleich noch aus.

Die [Vergleichsfälle](../sortsys-webapp-v2/app/lib/search/documentQuery.test.mjs)
prüfen Wortformen, Syntax, Bewertung und Ausschnitte. Der
[native Mehrinstanztest](../sortsys-webapp-v2/scripts/test-native-document-search.ts)
prüft gebündelte Folgeseiten, Versionswechsel, eine Löschung während der Suche
und den Entzug von Freigaben bei geöffnetem Client-Cache. Nach einem
Versionswechsel einer E-Mail findet er nur den Text der aktuellen Fassung.
Chromium zählt die wiederverwendeten Textblöcke beim Ändern der Suchbegriffe.
Bei einem Rechteentzug über einen anderen API-Prozess verschwinden der Treffer
und sein Worker aus der laufenden Sitzung. Weitere Browsertests suchen in
PDF-, Word-, Excel- und PowerPoint-Dateien sowie in EML- und MSG-Nachrichten.
