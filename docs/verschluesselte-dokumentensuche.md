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
Dateinamen und Ausschnitte bleiben im Client. Bei der Suche in einem Projekt
fordert der Browser den Berechtigungsnachweis und die erste Dateiseite zusammen an.
Die Suche über mehrere Projekte lädt Dateisammlungen gebündelt. Weitere Abrufe
prüfen ihren Änderungsstand. Die Textauswertung läuft in einem eigenen Worker.
Er hält für den laufenden Suchlauf bereits verarbeitete Wörter im Speicher.
Eine neue Suchanfrage oder das Ende der Sitzung beendet den Worker. Der Browser
liest die Projektbezeichnungen gebündelt für die angezeigten Treffer. Vor der
Ausgabe prüft er die Freigaben und Stände aller durchsuchten Dateisammlungen erneut.
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
prüft getrennte Dateifreigaben, Versionswechsel, eine Löschung während der Suche
und den Entzug von Freigaben bei geöffnetem Client-Cache. Der Browsertest sucht
nach Text aus hochgeladenen PDF-, Word-, Excel- und PowerPoint-Dateien.
