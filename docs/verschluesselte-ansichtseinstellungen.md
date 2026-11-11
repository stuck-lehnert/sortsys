# GAEB-Ansichtseinstellungen behalten

Feldrahmen, Gliederung, Gliederungsbreite, Menüband und Zoom werden automatisch
für das angemeldete Konto gespeichert. Beim erneuten Öffnen eines Editors
stehen sie wieder zur Verfügung. Die Werte liegen verschlüsselt auf dem Server;
die API erhält weder die einzelnen Einstellungen noch einen Klartextaufruf von
`personalization.gaebView.get` oder `.set`.

Jedes Konto verwendet einen eigenen Bereich `preferences:user:<id>:master-data`.
Dieser Bereich gehört zur normalen Kontoeinrichtung und benötigt keine
KI-Freigabe. Andere gewöhnliche Benutzer erhalten seinen Schlüssel nicht.
Die Administration behält für Bestandsübernahme und Verwaltung einen
ausdrücklichen Zugriff. Diese Einstellungen sind damit vor dem Betreiber
geschützt, aber kein persönliches Geheimnis gegenüber der Mandantenadministration.

Beim Übernehmen des Bestands liest der Browser die bisherigen Einstellungen
aus dem geprüften Archiv und bindet sie an ihre ursprünglichen Benutzerkennungen.
Fehlende Werte erhalten die bisherigen Standardwerte. Ein wiederholter
Übernahmeversuch vergleicht den bereits gespeicherten Inhalt. Die Recovery
behält diese Bereiche; ein dabei neu angelegtes Administrationskonto beginnt
mit eigenen Standardwerten.

Eine Änderung wird erst nach erneutem Lesen und Prüfen des verschlüsselten
Objekts als gespeichert behandelt. Fehlt lediglich die Antwort auf einen
erfolgreichen Schreibvorgang, erkennt der Browser den gespeicherten Stand.
Eine Erfolgsantwort ohne gespeichertes Objekt genügt nicht.
Änderungshinweise erreichen auch Browser an einer anderen API-Instanz und
verwerfen dort den betroffenen Zwischenspeicher. Ein bereits geöffneter Editor
übernimmt während der Arbeit keinen fremden Zoomwechsel; die nächste Abfrage
beziehungsweise das nächste Öffnen verwendet die aktuellen Werte.

Noch wartende Speichervorgänge bleiben an das Konto gebunden, das die Änderung
vorgenommen hat. Ein Kontowechsel verwirft diese Arbeiten. Das normale Schließen
des Dialogs sendet die letzte Änderung noch ab. Scheitert das Speichern, bleibt
sie im geöffneten Tab für einen erneuten Versuch erhalten; eine wiederhergestellte
Netzverbindung löst diesen Versuch aus. Ein Neuladen kann noch ungespeicherte
Einstellungen verlieren.
