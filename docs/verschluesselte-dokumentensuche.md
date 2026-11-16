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
Kennung. Der Ausschnitt zeigt die Umgebung eines Treffers und hebt passende
Wörter hervor. HTML und andere Zeichen aus dem Dokument bleiben gewöhnlicher
Text.

## Durchsuchbare Inhalte

Beim Hochladen liest der Browser die eingebettete Textschicht eines PDFs aus und
verschlüsselt den Text zusammen mit den Dateimetadaten. Übernommene Bestände
können ebenfalls bereits ausgelesenen Text enthalten. Ohne Textschicht ist ein
Scan nur über seinen Dateinamen auffindbar. Die Suche startet weder OCR noch
eine LLM-Anfrage. Nach einer Dateiänderung wird ein veralteter Textstand entfernt;
ein erneutes Auslesen nach jeder Bearbeitung ist noch nicht angeschlossen.

Eine Dateifreigabe öffnet keine Projektstammdaten. Fehlt deren Leserecht, erscheint
der Treffer ohne Projektbezeichnung. Dateien aus nicht freigegebenen Bereichen
liefern weder Treffer noch Ausschnitte.

Die API erhält verschlüsselte Datensätze und technische Kennungen. Suchbegriffe,
Dateinamen und Ausschnitte bleiben im Client. Der erste Abruf mehrerer
Dateisammlungen wird gebündelt; weitere Abrufe prüfen deren Änderungsstand.
Die Textauswertung läuft in einem eigenen Worker. Eine neue Suchanfrage oder das
Ende der Sitzung beendet den vorherigen Worker. Vor der Ausgabe werden die
Freigaben erneut geprüft, damit zwischenzeitlich entzogene Bereiche nicht aus
dem bereits gefüllten Cache erscheinen.

Auf einem neuen Gerät müssen zunächst alle freigegebenen Suchdaten geladen
werden. Originaldateien werden dafür nicht erneut heruntergeladen. Die
entschlüsselten Suchdaten liegen im Arbeitsspeicher, nicht in einer dauerhaften
Browserdatenbank.

## Vergleich mit der bisherigen Suche

Die Wortstammverarbeitung verwendet die deutschen und englischen Algorithmen aus
[@orama/stemmers](https://github.com/oramasearch/orama/tree/main/packages/stemmers).
Die Suchsyntax orientiert sich an
[PostgreSQLs Websuche](https://www.postgresql.org/docs/current/textsearch-controls.html#TEXTSEARCH-PARSING-QUERIES).
Die bisherige Trefferreihenfolge wird jedoch nicht exakt reproduziert.
Insbesondere Stoppwörter, URLs, zusammengesetzte Wörter und besondere Satzzeichen
benötigen weitere Vergleichsfälle. Es besteht deshalb noch kein Nachweis einer
vollständigen Übereinstimmung mit `websearch_to_tsquery` und `ts_rank_cd`.

Die [Vergleichsfälle](../sortsys-webapp-v2/app/lib/search/documentQuery.test.mjs)
prüfen Wortformen, Syntax, Bewertung und Ausschnitte. Der
[native Mehrinstanztest](../sortsys-webapp-v2/scripts/test-native-document-search.ts)
prüft getrennte Dateifreigaben und den Rechteentzug bei geöffnetem Client-Cache.
Browsertests verwenden den tatsächlichen Worker und eine lokal ausgelesene PDF.
