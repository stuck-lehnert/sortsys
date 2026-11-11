# Unternehmensanschrift und Rechnungsnummernschema

Die Formulare unter Verwaltung → Organisation lesen und ändern ihre Werte über
den verschlüsselten Browseradapter. Für die Kalkulation einer Angebotsaufforderung
steht damit dieselbe hinterlegte Unternehmensanschrift zur Verfügung wie im
Organisationsformular. Die Anschrift muss beim Beginn der Kalkulation nicht
erneut eingegeben werden.

Firmenname und Anschrift gehören zum Bereich `organization:master-data`. Das
Rechnungsnummernschema liegt mit eigenem Schlüssel in `organization:billing`.
Eine normale Einladung gibt die Anschrift zum Lesen frei, einschließlich der
benötigten früheren Schlüsselgenerationen. Sie gibt weder Schreibrechte noch
den Schlüssel für das Nummernschema weiter. Die Verwaltungsformulare verlangen
für Änderungen zusätzlich die Administrationsrolle. Die API prüft bei jeder
verschlüsselten Schreibaktion die signierte Freigabe für den jeweiligen Bereich.

Die fünf Nummernschemata und die vorhandene Vorschau bleiben erhalten.
Startnummern werden als Dezimalzeichenfolge geprüft und gespeichert, damit auch
große Zähler nicht durch JavaScript-Zahlen gerundet werden. Das stellt noch
keine Rechnungsnummer aus. Nummernvergabe, Eindeutigkeit und die Verbindung mit
Rechnungen benötigen weiterhin den gesonderten Abrechnungsablauf.

## Speichern und Übernahme des Bestands

Beim Speichern prüft der Browser die Felder, verschlüsselt und signiert den
neuen Stand und übermittelt die zuvor gelesene technische Version. Zwei
Administratoren können denselben beim Speichern gelesenen Ausgangsstand nicht
unbemerkt überschreiben: Einer der konkurrierenden Schreibvorgänge erhält einen
Konflikt. Erst das erneute Lesen und Prüfen der gespeicherten Signatur bestätigt
die Änderung.
WebSocket-Hinweise verwerfen auch an einer anderen API-Instanz die betroffenen
Browserzwischenspeicher. Ein Kontowechsel verwirft sie vollständig.

Jede geöffnete Formularansicht hält außerdem ihren eigenen signierten
Ausgangsstand fest. Eine zwischenzeitliche Änderung wird damit auch dann erkannt,
wenn sie bereits vor dem Speicherversuch abgeschlossen war. Abfragen aus anderen
Ansichten und WebSocket-Aktualisierungen ersetzen diesen Ausgangsstand nicht.
Bei einem Konflikt bleiben die Eingaben sichtbar. „Aktuellen Stand laden“ lädt
die veröffentlichten Werte; erst bestätigtes Speichern schreibt den
Ausgangsstand dieser Formularansicht fort.

Die Bestandsübernahme liest ausschließlich das bereits geprüfte, verschlüsselte
Archiv. Sie übernimmt die Unternehmensanschrift aus dessen Mandantendaten und
das vorhandene Nummernschema aus `global_settings`. Ohne eigene Konfiguration
gilt „global fortlaufend“, beginnend mit 1. Ein Wiederholungsversuch vergleicht
bereits übernommene Werte, statt sie zu überschreiben.

Die gesamte Bestandsumstellung ist noch nicht freigegeben. Die alten
Klartextbestände bleiben bis zum vollständigen Abschluss erhalten.
[Typst-Vorlagen und ihre Anlagen](verschluesselte-druckvorlagen.md) verwenden
einen eigenen Schlüsselbereich. Weitere Organisationseinstellungen sind noch
nicht angeschlossen; sie erhalten dadurch keinen stillschweigenden Zugriff
über die alte Klartext-API.
