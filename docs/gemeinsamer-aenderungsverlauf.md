# Änderungen nachverfolgen

Im Dashboard stehen zuletzt geänderte Projekte, Stammdaten und Berichte. Die
Detailansichten zeigen Änderungen am jeweiligen Datensatz. Bei verschlüsselten
Inhalten baut der Browser diese Ansichten aus angenommenen, signierten
Datenständen auf. Namen, betroffene Felder und Suchbedingungen gehen dafür nicht
an eine Klartext-Verlaufsabfrage der API.

Beispielsweise kann eine Änderung am Mitarbeiterprofil aus einer neuen
Telefonnummer und einem neuen Stundensatz bestehen. Ohne Kalkulationsfreigabe
erscheint nur die Telefonnummer im Verlauf. Der Name des Bearbeiters ist nur mit
dessen Stammdatenfreigabe lesbar. Bereits früher gelesene Informationen lassen
sich durch einen späteren Rechteentzug allerdings nicht zurückholen.

Die Zeitleiste eines Werkzeugs fragt nur die passenden Werkzeugdaten,
Werkzeugbuchungen und übernommenen Altverläufe als Kandidaten ab. Die Zuordnung
einer Buchung zum Werkzeug prüft weiterhin der Browser, da diese Beziehung
verschlüsselt ist. Ein Wechsel zur vollständigen Aktivitätsliste verwirft den
begrenzten Verlaufscache.

## Alte Einträge übernehmen

Die Bestandsumstellung liest `entity_changes` aus dem geprüften, verschlüsselten
Quellarchiv. Sie erhält die ursprüngliche Aktion, deren Zeitpunkt, die
betroffene Zeile und die gespeicherten Urheberangaben. Auch Hinweise auf
gelöschte Datensätze bleiben erhalten. Ein kopierter aktueller Datensatz gilt
dabei nicht als neu ausgeführte Änderung.

Die Mandantenautorität bestätigt den verschlüsselten Eintrag zusammen mit seiner
Quellkennung und seinem ursprünglichen Zeitpunkt. Das ist ein Nachweis der
Übernahme, keine nachträglich erfundene Signatur des damaligen Bearbeiters. Der
Nachweis gilt nur für diese erste, unveränderliche Veröffentlichung. Die API
nimmt ihn ausschließlich während der Bestandsumstellung an. Ein leerer oder
entfernter Nachweis erlaubt weder eine Änderung noch eine Löschung.

Änderungsfelder werden entsprechend ihren Inhaltsbereichen getrennt
verschlüsselt. Historische Namen verwenden ebenfalls getrennte Schlüssel:

| Angabe                                               | Erforderliche Freigabe             |
| ---------------------------------------------------- | ---------------------------------- |
| Änderung eines internen Stundensatzes                | Kalkulationsbereich der Person     |
| Frühere Bezeichnung eines Produkts oder Mitarbeiters | Stammdaten des jeweiligen Bereichs |
| Frühere Datei- oder Ordnerbezeichnung                | Anlagenbereich des Projekts        |
| Damaliger Projektname als Kontext eines Berichts     | Projektstammdaten                  |
| Gespeicherter Name eines Bearbeiters                 | Stammdaten dieser Person           |

Ein Bearbeiter ohne auflösbare Benutzerkennung erhält keine erfundene Identität.
Seine überlieferten Angaben bleiben in einem zunächst nur für die Autorität
freigegebenen Bereich erhalten. Dasselbe gilt für alte Kontoänderungen und
Einträge, deren Fachbereich noch nicht eindeutig einem heutigen Schlüssel
zugeordnet werden kann. Für diese zusätzlichen historischen Bereiche fehlt noch
eine Auswahl in der normalen Rechteverwaltung. Technische Einträge ohne einen
darstellbaren Datensatz bleiben wie bisher außerhalb des gemeinsamen Verlaufs;
das vollständige Quellarchiv enthält sie weiterhin.

Der bisherige Anwendungstrigger speicherte keine freien Beschreibungen in
`entity_changes`. Sollte ein anders befüllter Bestand eine Beschreibung zusammen
mit Änderungen mehrerer Schlüsselbereiche enthalten, hält die Übernahme an. Sie
verteilt den möglicherweise vertraulichen Text nicht unter breitere Rechte.
Diese Sonderfälle benötigen noch eine Zuordnung.

Eine unterbrochene Übernahme lässt sich wiederholen. Bereits vorhandene Inhalte
und Herkunftsnachweise werden erneut geprüft; ein abweichendes Ziel wird nicht
überschrieben.

## Reihenfolge und gleichzeitige Änderungen

Der Verlauf sortiert nach Zeitpunkt und laufender Kennung. Mikrosekunden bleiben
bei übernommenen Einträgen erhalten. Daher erscheint eine alte Änderung auch
dann an ihrer damaligen Stelle, wenn ihre Übernahme später als eine neue
Änderung gespeichert wurde. Zusammengehörige Teile werden vor der Ausgabe einer
Seite zusammengeführt.

Mehrere API-Instanzen können Änderungen verschiedener Bereiche in anderer
Reihenfolge abschließen, als ihre laufenden Kennungen vergeben wurden. Eine
unveränderte höchste Kennung allein beweist deshalb keinen unveränderten
Verlauf. Die Abfrage berücksichtigt zusätzlich die Anzahl der unveränderlichen
Einträge. Der Browser kontrolliert bei jeder Abfrage auch die aktuellen
signierten Leserechte und verwirft seinen Cache bei einem Rechtewechsel.

Zeitpunkt und Quellkennung einer übernommenen Änderung sind sichtbare
Protokollmetadaten. Ihre Signatur bestätigt die unveränderte Zuordnung zum
übernommenen Stand, nicht die Wahrheit der ursprünglichen Zeitangabe. Für einen
unabhängigen Existenznachweis gelten die Grenzen der
[OpenTimestamps-Anbindung](zeitnachweise.md).

## Stand der Prüfung

Die Kryptografietests prüfen veränderte und entfernte Herkunftsnachweise. Die
Modelltests vergleichen getrennte Feldfreigaben, historische Namen, gelöschte
Datensätze und die Reihenfolge bis auf Mikrosekunden. Ein Test hält eine
Änderung zunächst zurück und gibt sie erst nach einer höheren Kennung frei; sie
muss dann trotz zwischengespeicherter Ergebnisse erscheinen.

Der native Fachadapterlauf enthält die wiederholte Übernahme eines tatsächlichen
Quellarchivs über PostgreSQL, Quack und zwei unabhängige API-Prozesse. Sein
Ergebnis ist zusammen mit den übrigen Integrationsprüfungen zu beurteilen;
Modelltests allein belegen weder die vollständige Fachparität noch die
Geschwindigkeit bei großen Beständen.
