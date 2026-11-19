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

## Eigene Einsätze

Mitarbeitende können ihre zugewiesenen Einsätze ohne Leserecht für die gesamte
Baustellenplanung öffnen. Beim Speichern verschlüsselt der Browser den Schlüssel
der einzelnen Einsatzrevision zusätzlich für die zugewiesene Person. Dieser
Schlüssel öffnet weder andere Einsätze noch spätere Revisionen. Ausdrückliche
Lesesperren und Kontosperren gelten auch für diese automatische Freigabe.

Ein Einsatz kann bereits vor der ersten Anmeldung angelegt werden. Bei der
Bestätigung der Einladung ergänzt der freigebende Verwalter die Schlüsselpakete
für bestehende Einsätze in den Planungsbereichen, die er lesen und bearbeiten
darf. Dafür bleibt der Klartext im Browser. Eine Neuzuweisung oder Löschung
entfernt die bisherige Freigabe in derselben Transaktion wie die Planungsänderung.
Bereits gelesene Inhalte lassen sich dadurch nicht nachträglich entziehen.

Die Eigenansicht ist über das gewöhnliche Planungsmenü erreichbar. Bei Anlage
oder Baustellenwechsel verschlüsselt der Browser die Projektbezeichnung mit
dem Einsatz. Bei einer Umbenennung veröffentlicht er die neue Bezeichnung
auch für Mitarbeitende mit einem freigegebenen Einsatz in diesem Projekt.
Dafür prüft der Browser die signierten Freigaben und die zertifizierten
öffentlichen Schlüssel der Empfänger. Die API vergleicht diese Auswahl beim
Speichern mit den aktuellen Zuweisungen und speichert beide Fassungen
gemeinsam. Sie kennt die Zuordnung zwischen Projekt, Einsatz und Empfänger.
Zeiten, Kommentare und Projektbezeichnungen bleiben verschlüsselt.

Beim Öffnen laufen die Zugriffsprüfung und der Abruf der ersten verschlüsselten
Seite parallel. Die API liest die Inhalte einer Seite gesammelt aus DuckDB und
liefert Bezeichnung und Signaturnachweis einmal pro Projekt mit. Vor der Anzeige
prüft der Browser die Berechtigung der Person, die das Projekt umbenannt hat.
Ein Schlüssel für die Projektstammdaten wird dafür nicht verteilt.

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
Baustellensperren und Abwesenheiten gelten für volle Kalendertage einschließlich
des Endtags. Formular und Abfrage übergeben diese Tage als Datumszeichenfolgen.
Die Planungsansicht zeigt sie am selben Kalendertag in der jeweiligen Zeitzone
an. Die Bestandsübernahme erhält die gespeicherten Zeitpunkte einschließlich
ihrer Mikrosekunden.

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
neu. Der zusätzliche Test der Eigenansicht prüft inzwischen auch die Recovery.

Der [native Test der Eigenansicht](../sortsys-webapp-v2/scripts/test-native-planning-recipients.ts)
verwendet zwei getrennte API-Prozesse und zwei Benutzerkonten.
Er prüft Einsätze vor der Einladung, eigene Inhalte ohne Bereichsschlüssel,
abgewiesene Fremdzugriffe und Schreibversuche sowie fehlende oder manipulierte
Empfängernachweise. Auch ausdrückliche Lesesperren, Signaturschlüsselwechsel,
Baustellenwechsel, Neuzuweisung und Löschung werden geprüft. Änderungen der ersten
API erreichen den gewöhnlichen Planungsstream über den WebSocket der zweiten.

Derselbe Test führt zwei Recoveries mit der jeweils aktuellen Phrase durch.
Einsätze, Benutzerkennungen und eine zwischen den Recoveries geänderte
Baustellensperre bleiben erhalten. Der Test prüft, dass alte Phrasen, Sitzungen
und Passwörter abgewiesen werden und alte private Schlüssel die erneuerten
Empfängerpakete nicht öffnen können. Eine erneute Einladungsfreigabe stellt die
Eigenansicht ohne Bereichsschlüssel wieder her. Die Baustellensperre bleibt für
dieses Konto gesperrt.

Mit `SORTSYS_NATIVE_BROWSER=1` prüft dieser Ablauf außerdem die fertig gebaute
Webapp nach der zweiten Recovery in getrennten Chromium-Sitzungen. Die
Mitarbeitersicht zeigt den eigenen Einsatz mit Projektbezeichnung, verbirgt
fremde Einsätze und bietet keine Planungsaktionen an. Änderungen und Löschungen
aus der anderen Sitzung werden ohne manuelles Neuladen sichtbar. Das berechtigte
Konto sieht die wiederhergestellte Baustellensperre in Berlin am ersten Tag und
in Los Angeles am letzten Tag. Nach dem Löschen über die erste API verschwindet
sie auch in der zweiten Sitzung. Der Test prüft zudem einen Seitenreload und
sucht im HTTP-Verkehr nach unverschlüsselten Testinhalten. Screenshots, Traces
und Ergebnisse liegen im Testverzeichnis unter `browser-artifacts/own-planning`.

Eine Bereichsfreigabe öffnet weiterhin alle Einsätze dieser Baustelle. Persönliche
[Abwesenheiten samt Urlaubskontingent und Genehmigung](abwesenheiten-protokoll.md)
haben inzwischen einen eigenen verschlüsselten Adapter. Die vollständige
Verfügbarkeitsdarstellung braucht noch einen gemeinsamen Vergleich dieser
Freigaben. Projektlöschkaskaden und die physische Bereinigung früherer
verschlüsselter Zuordnungen bleiben weitere Aufgaben.
