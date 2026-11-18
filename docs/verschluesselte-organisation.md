# Organisation: Anschrift, Rechnungsnummern und Logo

Die Formulare unter Verwaltung → Organisation lesen und ändern ihre Werte über
den verschlüsselten Browseradapter. Für die Kalkulation einer
Angebotsaufforderung steht damit dieselbe hinterlegte Unternehmensanschrift zur
Verfügung wie im Organisationsformular. Die Anschrift muss beim Beginn der
Kalkulation nicht erneut eingegeben werden.

Auch der Dokumentdruck verwendet das entschlüsselte Organisationsprofil als
Absender. Firmenname, Straße, Postleitzahl, Ort und Land werden für GAEB-Dateien
und andere strukturierte PDFs gleich aufbereitet. Ein ausdrücklich im Dokument
hinterlegter Absender bleibt erhalten. Ist das Organisationsprofil nicht lesbar
oder noch leer, bleibt das Dokument ohne diesen ergänzten Briefkopf druckbar.

Firmenname und Anschrift gehören zum Bereich `organization:master-data`. Das
Rechnungsnummernschema liegt mit eigenem Schlüssel in `organization:billing`.
Eine normale Einladung gibt die Anschrift zum Lesen frei, einschließlich der
benötigten früheren Schlüsselgenerationen. Sie gibt weder Schreibrechte noch den
Schlüssel für das Nummernschema weiter. Die Verwaltungsformulare verlangen für
Änderungen zusätzlich die Administrationsrolle. Die API prüft bei jeder
verschlüsselten Schreibaktion die signierte Freigabe für den jeweiligen Bereich.

Die fünf Nummernschemata und die vorhandene Vorschau bleiben erhalten.
Startnummern werden als Dezimalzeichenfolge geprüft und gespeichert, damit auch
große Zähler nicht durch JavaScript-Zahlen gerundet werden. Der
[Abrechnungsablauf](verschluesselte-abrechnung.md) verwendet diese Einstellung
beim Ausstellen. Zähler und belegte Nummern haben einen weiteren
Schlüsselbereich; die entsprechende Benutzerfreigabe erlaubt keine Änderung des
Nummernschemas.

## Logo für Vorschau und Druck

Im Tab „Logo“ lässt sich ein PNG-, JPEG- oder WebP-Bild auswählen. Der Browser
berücksichtigt die Bildausrichtung, begrenzt die längste Seite auf 2.048 Pixel
und erzeugt ein PNG ohne die ursprünglichen Bildmetadaten. Transparente Flächen
bleiben erhalten. Die Quelldatei darf höchstens 20 MiB groß sein; das fertige
Bild höchstens 10 MiB. Für diesen Ablauf ist kein Medienjob auf dem Server
nötig.

Bilddaten, Dateiname und Abmessungen werden im Bereich `organization:attachment`
verschlüsselt. Damit können Konten mit Lesefreigabe das Logo für Vorschau und
Dokumentdruck verwenden, ohne Zugang zum vollständigen Bestandsarchiv zu
erhalten. Der Browser lädt die verschlüsselten Blöcke und prüft vor der Anzeige
deren Signaturen und die im Dateiverzeichnis festgehaltenen Hashwerte. Lokale
Bild-URLs werden beim Sperren des Zugangs oder einem Berechtigungswechsel
freigegeben.

Ein neues Bild ersetzt das vorhandene erst nach bestätigtem Speichern. Bei einem
Fehler bleibt die ausgewählte Datei für „Erneut versuchen“ erhalten. Eine
konkurrierende Änderung wird als Konflikt gemeldet. Bisherige Bildblöcke bleiben
bis zur gesonderten Bereinigung alter Dateiversionen gespeichert.

Die Bestandsübernahme kopiert ein fertig verarbeitetes Logo bytegetreu aus dem
bestätigten verschlüsselten Dateiarchiv. Auch der signierte Übernahmenachweis
wird erneut geprüft. Wiederholungen verändern bestätigte Blöcke und Datensätze
nicht. War die alte Verarbeitung noch nicht abgeschlossen, erscheint ein Hinweis
zur erneuten Bildauswahl; vorhandene Quelldateien bleiben im Bestandsarchiv. Ein
ungültiger oder nicht eindeutig zuordenbarer Archivnachweis stoppt die
Übernahme, statt das Logo stillschweigend wegzulassen.

## Speichern und Übernahme des Bestands

Beim Speichern prüft der Browser die Felder, verschlüsselt und signiert den
neuen Stand und übermittelt die zuvor gelesene technische Version. Zwei
Administratoren können denselben beim Speichern gelesenen Ausgangsstand nicht
unbemerkt überschreiben: Einer der konkurrierenden Schreibvorgänge erhält einen
Konflikt. Erst das erneute Lesen und Prüfen der gespeicherten Signatur bestätigt
die Änderung. WebSocket-Hinweise verwerfen auch an einer anderen API-Instanz die
betroffenen Browserzwischenspeicher. Ein Kontowechsel verwirft sie vollständig.

Jede geöffnete Formularansicht hält außerdem ihren eigenen signierten
Ausgangsstand fest. Eine zwischenzeitliche Änderung wird damit auch dann
erkannt, wenn sie bereits vor dem Speicherversuch abgeschlossen war. Abfragen
aus anderen Ansichten und WebSocket-Aktualisierungen ersetzen diesen
Ausgangsstand nicht. Bei einem Konflikt bleiben die Eingaben sichtbar.
„Aktuellen Stand laden“ lädt die veröffentlichten Werte; erst bestätigtes
Speichern schreibt den Ausgangsstand dieser Formularansicht fort.

Die Bestandsübernahme liest ausschließlich das bereits geprüfte, verschlüsselte
Archiv. Sie übernimmt die Unternehmensanschrift aus dessen Mandantendaten und
das vorhandene Nummernschema aus `global_settings`. Ohne eigene Konfiguration
gilt „global fortlaufend“, beginnend mit 1. Ein Wiederholungsversuch vergleicht
bereits übernommene Werte, statt sie zu überschreiben.

Die Backupübernahme richtet einen neuen Mandanten ein und verändert keine Daten
der früheren Installation.
[Typst-Vorlagen und ihre Anlagen](verschluesselte-druckvorlagen.md) verwenden
einen eigenen Schlüsselbereich. Weitere Organisationseinstellungen sind noch
nicht angeschlossen; sie erhalten dadurch keinen stillschweigenden Zugriff über
die alte Klartext-API.
