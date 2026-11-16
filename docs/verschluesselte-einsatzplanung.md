# Einsatzplanung mit verschlüsselten Projektdaten

Die Einsatzplanung ordnet Mitarbeitende einer Baustelle und einem Zeitraum zu.
Zusätzlich lassen sich Baustellensperren erfassen, etwa für den Gerüstabbau oder
fehlenden Baustrom. Zeiten, Mitarbeiterzuordnungen, Gründe und Kommentare werden
im Browser verschlüsselt. Die API erhält signierte Speicherpakete und technische
Kennungen.

## Zugriffe je Baustelle

Unter **Verwaltung → Organisation → Datenschutz → Projektzugriff** verwaltet
**Einsatzplanung und Baustellensperren** einen eigenen Bereich je Projekt. Die
Freigabe öffnet weder Kalkulationspreise noch Lieferscheine oder
Arbeitszeitberichte. Lesen, Anlegen, Bearbeiten und Löschen lassen sich über die
gemeinsame Rechteauswahl getrennt vergeben. Für die Mitarbeiter- und
Projektauswahl sind außerdem die jeweiligen Namens- und Grunddatenfreigaben
erforderlich.

Der Bereich heißt technisch `project:<id>:planning:master-data`. Neue Projekte
erhalten ihn zusammen mit ihren anderen Schlüsselbereichen. Zertifizierte
Projektanlagen binden ihn an den ursprünglichen Projektersteller; eine
Anlageberechtigung für neue Projekte erlaubt keine Erweiterung einer fremden
Baustelle. Bei der Bestandsumstellung wird auch für Projekte ohne bisherige
Einsätze ein Bereich vorbereitet.

## Verschieben und gemeinsam planen

Ein Einsatz kann auf eine andere Baustelle wechseln und später zurückkehren.
Dabei bleibt seine öffentliche Kennung erhalten. Der Browser veröffentlicht die
Löschung der alten Zuordnung und die neue Zuordnung in einer Transaktion. Dafür
werden Leserechte in beiden Bereichen, Löschen im Ausgangsbereich und Anlegen im
Zielbereich benötigt. Eine Änderung innerhalb derselben Baustelle verlangt
Bearbeiten.

Jeder Wechsel erhält eine neue Speicherkennung. Die frühere Zuordnung bleibt als
signierte Löschmarkierung erhalten und wird nicht wiederbelebt. Der
Versionsbeleg des Formulars umfasst deshalb sowohl Speicherkennung als auch
Revision. Ein altes Formular kann einen zwischenzeitlich verschobenen und
zurückgeschobenen Einsatz nicht überschreiben. Auch eine konkurrierende Änderung
zwischen Vorbereitung und Veröffentlichung lässt den ganzen Wechsel scheitern.

Bei der Anlage für mehrere Personen behalten Wiederholungen die bereits
verwendeten Kennungen. Eine verlorene Antwort führt dadurch nicht zu einer
zweiten Buchung. Erst das erneute Lesen der tatsächlich gespeicherten Signaturen
bestätigt einen Schreibvorgang.

Die Oberfläche bezieht aktualisierte Listen über ihre bestehende Subscription.
Verschlüsselte Änderungsereignisse lösen das Nachlesen aus; der frühere
Drei-Sekunden-Abgleich entfällt. Vollständige Listen entfernen auch Einträge,
die inzwischen gelöscht oder aus dem angezeigten Zeitraum verschoben wurden.

Einsätze verwenden Zeitpunkte mit Zeitzone und ein ausgeschlossenes Ende.
Baustellensperren verwenden einschließlich ihres Endtags reine Kalendertage. Das
Formular übergibt diese Tage als Datumszeichenfolge, damit der Wechsel zur
Sommerzeit keinen Tag verschiebt. Die Bestandsübernahme erhält die gespeicherten
Zeitpunkte einschließlich ihrer Mikrosekunden.

## Prüfstand und offene Abläufe

Die lokalen Prüfungen verwenden echte Signaturen und Verschlüsselung sowie eine
DuckDB-Projektion. Sie prüfen unter anderem Wechsel in beide Richtungen,
Gleichzeitigkeitskonflikte, Löschrechte ohne Bearbeiten, verlorene Antworten,
wiederholte Bestandsübernahme und das Verwerfen von Klartext beim Kontowechsel.
Browserprüfungen bedienen die tatsächliche Planungsseite und ihre Dialoge. Die
native Protokollprüfung umfasst den zusätzlichen Projektbereich.

Der
[native Fachablauf](../sortsys-webapp-v2/scripts/test-native-business-workflows.ts)
verbindet zwei echte API-Instanzen. Er prüft eine wiederholte Anlage, atomare
Baustellenwechsel und Rückwechsel, veraltete Formulare, Löschen sowie verlorene
und fälschlich erfolgreiche Speicherantworten. Die Clients dieses Tests
verwenden kein WebSocket; sie laden den Stand der anderen Instanz ausdrücklich
neu. Die anschließende Recovery dieser Planungsdaten ist noch nicht
nachgewiesen.

Eine Lesefreigabe für die Planung öffnet die Einsätze dieser Baustelle. Die
bisherige automatische Ansicht ausschließlich eigener Einsätze benötigt noch
eine eigene Verteilung von Leseschlüsseln. Persönliche
[Abwesenheiten samt Urlaubskontingent und Genehmigung](abwesenheiten-protokoll.md)
haben inzwischen einen eigenen verschlüsselten Adapter. Die vollständige
Verfügbarkeitsdarstellung braucht noch einen gemeinsamen Vergleich dieser
Freigaben. Projektlöschkaskaden und die physische Bereinigung früherer
verschlüsselter Zuordnungen bleiben weitere Aufgaben.
