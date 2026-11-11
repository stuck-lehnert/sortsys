# Projektdateien im verschlüsselten Arbeitsbereich

Pläne, E-Mails und weitere Projektanhänge werden im Browser verschlüsselt. Auch
Dateinamen, Ordner, Vorschaubilder und durchsuchbarer PDF-Text gehören zum
geschützten Inhalt. Die API und der DuckDB-Dienst erhalten verschlüsselte Pakete
mit technischen Kennungen und Versionsangaben.

Die bestehende Projektablage verwendet diesen Zugriff zum Hochladen, Anzeigen,
Umbenennen, Verschieben und Herunterladen. Ordner lassen sich verschachteln;
Zyklen und das Löschen belegter Ordner weist der Client zurück. Eine Datei darf
derzeit höchstens 512 MiB groß sein.

## Dateien freigeben

Unter **Verwaltung → Organisation → Datenschutz → Projektzugriff** sind
**Projektgrunddaten** und **Projektdateien** getrennt einstellbar. Ein Mitarbeiter kann damit
Pläne bearbeiten, ohne den Schlüssel für die Projektgrunddaten oder eine
separate Kalkulation zu erhalten. Die Dateifreigabe gilt für den gesamten Dateibereich
des gewählten Projekts, nicht für einzelne Ordner.

Die Freigabe öffnet vollständige Originaldateien, einschließlich darin
enthaltener Preise. Die getrennte Freigabe von Mengen und Preisen innerhalb
nativer Geschäftsdokumente benötigt weiterhin den jeweiligen GAEB-Fachadapter.

Ein neu angelegtes Projekt erhält unabhängige Schlüssel für beide Bereiche.
Bei einer delegierten Projektanlage gehören der Ersteller und die festgelegten
Pflichtempfänger zum anfänglichen Leserkreis. Eine Anlageberechtigung für
Projekte erlaubt keine Dateifreigabe für fremde Projekte.

Beim Entzug eines Leserechts wechselt der Dateischlüssel. Frühere Schlüssel
öffnen danach weder neue Dateistände noch neue Dateinamen und Ordnerdaten.
Eine erneute Freigabe stellt auch benötigte ältere Schlüssel bereit.
Bereits heruntergeladene Kopien können nicht zurückgeholt werden.

Geöffnete Vorschauen werden bei Abmeldung, Kontowechsel oder einem gemeldeten
Rechteentzug entfernt. Der Browser bricht laufende Ladevorgänge ab und gibt die
lokalen Datei-URLs frei. Ein verspätetes Ladeergebnis darf keine Vorschau aus
dem vorherigen Zugriff wieder einsetzen.

## Anzeigen und suchen

PDFs werden nach der Entschlüsselung mit PDF.js geöffnet. EML und MSG verarbeitet
der vorhandene Parser im Browser; eingebettete Bilder bleiben möglich, entfernte
Bilder sind gesperrt. Bilder, Videos und DWG-Pläne verwenden ebenfalls lokale
Datei-URLs. Diese URLs verlassen den Browser nicht und gelten nur während der
geöffneten Vorschau.

Beim Hochladen erzeugt der Browser Bildvorschauen und liest eingebetteten
PDF-Text aus. Der daraus gewonnene Text wird zusammen mit den Dateimetadaten
verschlüsselt. Es startet dabei kein serverseitiger OCR- oder LLM-Auftrag.
Bildscans ohne eingebetteten Text bleiben deshalb ohne Volltext, solange kein
ausdrücklich aufgerufener Erkennungsvorgang angeschlossen ist.

Die Dateisuche berücksichtigt Dateinamen und vorhandenen extrahierten Text.
Wortanfänge und mehrere gemeinsam gesuchte Wörter werden lokal ausgewertet.
Die bisherige deutsche und englische PostgreSQL-Volltextsuche mit Ranking und
Trefferausschnitten ist damit noch nicht vollständig nachgebildet. Beim ersten
Zugriff müssen die berechtigten Metadaten synchronisiert werden; die
Originaldateien werden erst für die jeweilige Vorschau oder den Download geladen.

## Speichern und technische Prüfungen

Der Browser zerlegt eine Datei in Blöcke von höchstens 256 KiB und verschlüsselt
jeden Block. Erst nach bestätigter Ablage veröffentlicht er das verschlüsselte
Dateiverzeichnis mit den Hashes und der Reihenfolge aller Blöcke. Ausgetauschte,
fehlende oder umsortierte Blöcke führen beim Lesen zu einem Fehler. Bestätigte
Blöcke lassen sich auch durch einen berechtigten Schreiber nicht überschreiben;
eine Bearbeitung legt neue Blöcke an.

Dateimetadaten, Ordnerzuordnungen und Speicherstände werden vor der Übertragung
gegen das lokale Datenschema geprüft. Der Server prüft Signaturen, aktuelle
Berechtigungen und technische Versionen. Eine Speicherung bestätigt der Browser
erst nach erneutem Lesen des tatsächlich abgelegten Pakets. Der Ablauf verträgt
verlorene Antwortbestätigungen und verhindert, dass eine ältere Editorversion
einen neueren Stand überschreibt. Die Versionsprüfung gilt auch über mehrere
API-Instanzen hinweg.

Kann der Schreiber die Projektgrunddaten lesen, prüft er zusätzlich den dortigen
Projektstand und bindet ihn an dieselbe Speichertransaktion. Bei einer reinen
Dateifreigabe bleibt diese fachliche Prüfung über Bereichsgrenzen hinweg aus.
Die signierte Bereichszuordnung gilt weiterhin. Eine öffentlich prüfbare
Projektlöschung, die abhängige Bereiche verbindlich sperrt, steht noch aus.
Diese Grenze gehört zur vereinbarten
[clientseitigen Datenprüfung](verschluesselung-datenpruefung.md).

## Bestandsumstellung und offene Anschlüsse

Die Bestandsumstellung liest vorhandene Originale und fertige Vorschaubilder
über einen eingeschränkten Administrationszugriff. Sie prüft den eingefrorenen
Quellbestand und übernimmt Dateien schrittweise. Ein erneuter Lauf verwendet
bereits bestätigte Kopien, statt dieselben Originale nochmals zu übertragen.
Dieser Quellzugriff steht normalen Dateilesern nicht offen.

Die bisherigen Klartextdateien im Objektspeicher und die alten Datenbankzeilen
bleiben bis zum Abschluss der gesamten Umstellung eingefroren erhalten. Der
Mandant wird durch die Dateiübernahme allein noch nicht vollständig auf den
geschützten Betrieb umgeschaltet. Alte Sicherungen werden nicht nachträglich
verschlüsselt. Eine vollständige Sicherung braucht derzeit sowohl PostgreSQL
als auch die zugehörige DuckDB-Datei; der alte Objektspeicher bleibt bis zur
abschließenden Bereinigung ebenfalls relevant.

GAEB- und Diagrammdateien verwenden den verschlüsselten Weg für Öffnen und
Speichern. Andere geöffnete GAEB-Ansichten bekommen Hinweise auf gespeicherte
Stände. Die verschlüsselte Zusammenführung einzelner Tastatureingaben und
gemeinsame Cursor fehlen dort noch. Die normalen Office-Dialoge verwenden den
[CryptPad-Adapter](editoren-ohne-klartextserver.md) mit getrennten Lese- und
Bearbeitungszugängen. Ein Test mit zwei unabhängigen Browseranmeldungen bestätigt
gemeinsame Änderungen und das Öffnen dieses Standes mit einem reinen Lesezugang.
Vor einem erzwungenen Sitzungswechsel, etwa bei Rechteentzug, sind noch nicht als
Datei bestätigte Änderungen bisher nicht gesichert.

Bearbeitungen einer Datei entfernen bislang den alten Suchtext und das alte
Vorschaubild. Deren erneute Erzeugung nach einer Editoränderung ist noch
anzuschließen. Löschungen setzen verschlüsselte Markierungen; alte Blöcke und
abgebrochene Uploads werden noch nicht physisch bereinigt. Große Uploads laufen
blockweise, halten aber derzeit die lokale Warteschlange für Dateiänderungen
belegt.

Die [Datei-Integrationstests](../sortsys-webapp-v2/scripts/test-live-project-files.ts)
vergleichen übernommene PDF-, DWG-, MSG- und EML-Dateien bytegenau mit den
Originalen. Sie prüfen außerdem Versionskonflikte, verlorene Bestätigungen,
Ordnerbezüge und lokale Datei-URLs. Die
[Freigabetests](../sortsys-webapp-v2/scripts/test-live-file-permissions.ts)
prüfen getrennte Rechte, Entzug, Schlüsselwechsel und erneute Freigabe über
mehrere API-Instanzen. Browsertests öffnen echte PDF- und EML-Vorschauen und
prüfen deren Entfernung bei Kontowechsel und Rechteentzug.
