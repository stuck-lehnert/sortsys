# Besuchte Seiten und Dashboard-Fixierungen

Das Dashboard zeigt zuletzt besuchte Projekte und Dokumente sowie häufig
genutzte Schnellaktionen. URLs und Seitentitel können bereits Angaben über
Kunden oder Bauvorhaben enthalten. Deshalb speichert die Webapp diese Verläufe
verschlüsselt im persönlichen Bereich des angemeldeten Kontos.

Die bisherigen Aufrufe `personalization.visits.list` und `.append` sowie
`personalization.actions.list` und `.append` werden im Browser verarbeitet. An
die API gehen signierte verschlüsselte Objekte und technische Versionsangaben.
Es bleiben höchstens 100 Besuche und 200 Aktionsaufrufe erhalten. Die Sortierung
berücksichtigt die ursprünglichen Zeitstempel mit Mikrosekunden; bei gleichem
Zeitpunkt entscheidet die numerische Kennung.

Auch die bis zu zwölf fixierten Dashboard-Einträge liegen in diesem Bereich.
Anheften, Entfernen und Umordnen ändern den jeweils aktuellen Stand, statt eine
ältere vollständige Liste zurückzuschreiben. Drag-and-drop und Pfeiltasten
wirken auf dieselbe gespeicherte Reihenfolge. Nach einer bestätigten Änderung
können andere Browser den Stand über die bestehenden Änderungshinweise
nachladen.

## Eigener Bereich, gemeinsame Speicherprüfung

Verläufe und Fixierungen verwenden den bereits vorhandenen Schlüsselbereich
`preferences:user:<id>:master-data`. Die GAEB-Ansichtseinstellungen haben darin
einen getrennten Objektpräfix. So kann die persönliche Historie wachsen, ohne
beim Öffnen der Editor-Einstellungen als falsches Datenformat behandelt zu
werden.

Die normale Kontoeinrichtung und eine angenommene Einladung geben diesen Bereich
frei. Eine KI-Berechtigung ist dafür nicht erforderlich. Andere gewöhnliche
Benutzer erhalten den Schlüssel nicht. Die Mandantenadministration behält ihren
ausdrücklichen Verwaltungszugriff; diese Daten sind vor dem Betreiber geschützt,
aber kein persönliches Geheimnis gegenüber dieser Administration.

Die Inhaltsmodelle prüfen Benutzerkennung, Verlaufsart, Zeilenkennungen,
Zeitstempel und erlaubte Felder. Navigationsziele müssen interne Pfade sein. Ein
technischer Änderungshinweis ersetzt keine Speicherbestätigung: Die gemeinsame
Datenlaufzeit liest den geschriebenen Stand erneut und prüft seine Signatur. Bei
gleichzeitigen Einträgen liest sie nach einem Versionskonflikt den neuen
Ausgangsstand und versucht die Ergänzung erneut. Fehlgeschlagene Änderungen
ersetzen nicht die zuvor angezeigten Fixierungen. Abmeldung und Kontowechsel
verwerfen geladene Daten und noch wartende Antworten.

Ein persönlicher Verlauf kann weiterhin den Titel einer früher zugänglichen
Seite enthalten. Das erteilt keine Berechtigung, ihren heutigen Inhalt zu
öffnen. Wie andere bereits gelesene Daten lässt sich eine bekannte Bezeichnung
durch einen späteren Rechteentzug nicht kryptografisch zurückholen.

## Vorhandene Verläufe übernehmen

Die Bestandsumstellung übernimmt Besuchs- und Aktionsverläufe aus dem geprüften
Archiv in die ursprünglichen Benutzerbereiche. Wiederholungen vergleichen den
bereits gespeicherten Inhalt und überschreiben keine zwischenzeitlich geänderten
Daten. Die bisherigen Grenzen von 100 und 200 Einträgen gelten auch hier.

Ältere Dashboard-Fixierungen aus `localStorage` werden beim nächsten Öffnen des
Dashboards einmal für das betreffende Konto übernommen. Die Webapp verwendet
ausschließlich den Schlüssel mit der tatsächlichen Mandanten- und
Benutzerkennung. Eine unzugeordnete alte Liste unter `default` wird nicht
automatisch einem Mandanten zugeschlagen. Nach bestätigter verschlüsselter
Speicherung wird genau die übernommene lokale Kopie gelöscht. Es werden keine
neuen Klartextkopien angelegt. Scheitert die Übernahme, bleibt die alte Kopie
für einen erneuten Versuch erhalten und die Ansicht meldet den Fehler.

Der [gemeinsame Änderungsverlauf](gemeinsamer-aenderungsverlauf.md) verwendet
eigene verschlüsselte Quellen und folgt den Leserechten der jeweiligen Inhalte.
Er ist von diesen persönlichen Besuchs- und Aktionslisten getrennt. Die Tests
für persönliche Verläufe prüfen echte Verschlüsselung, zwei getrennte
Datenlaufzeiten, gleichzeitige Änderungen und verlorene Antworten. Der
Browsertest verwendet die tatsächliche Dashboard-Ansicht und DuckDB im Browser.
Zusätzlich prüft der
[native Fachadapterlauf](development.md#native-tests-ohne-entwicklungsstack) die
Bestandsübernahme, gleichzeitige Einträge und Fixierungen über zwei getrennte
API-Instanzen mit echter Quack-Ablage. Die gespeicherten Verlaufsobjekte bleiben
nach zwei aufeinanderfolgenden Recoveries unverändert lesbar. Ein vollständiger
Browserlauf über diese beiden Prozesse steht weiterhin aus.
