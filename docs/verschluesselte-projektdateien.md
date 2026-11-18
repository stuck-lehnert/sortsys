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
**Projektgrunddaten** und **Projektdateien** getrennt einstellbar. Ein
Mitarbeiter kann damit Pläne bearbeiten, ohne den Schlüssel für die
Projektgrunddaten oder eine separate Kalkulation zu erhalten. Die Dateifreigabe
gilt für den gesamten Dateibereich des gewählten Projekts, nicht für einzelne
Ordner.

Die Freigabe öffnet vollständige Originaldateien, einschließlich darin
enthaltener Preise. Die getrennte Freigabe von Mengen und Preisen innerhalb
nativer Geschäftsdokumente benötigt weiterhin den jeweiligen GAEB-Fachadapter.

Ein neu angelegtes Projekt erhält unabhängige Schlüssel für beide Bereiche. Bei
einer delegierten Projektanlage gehören der Ersteller und die festgelegten
Pflichtempfänger zum anfänglichen Leserkreis. Eine Anlageberechtigung für
Projekte erlaubt keine Dateifreigabe für fremde Projekte.

Beim Entzug eines Leserechts wechselt der Dateischlüssel. Frühere Schlüssel
öffnen danach weder neue Dateistände noch neue Dateinamen und Ordnerdaten. Eine
erneute Freigabe stellt auch benötigte ältere Schlüssel bereit. Bereits
heruntergeladene Kopien können nicht zurückgeholt werden.

Geöffnete Vorschauen werden bei Abmeldung, Kontowechsel oder einem gemeldeten
Rechteentzug entfernt. Der Browser bricht laufende Ladevorgänge ab und gibt die
lokalen Datei-URLs frei. Ein verspätetes Ladeergebnis darf keine Vorschau aus
dem vorherigen Zugriff wieder einsetzen.

## Anzeigen und suchen

PDFs werden nach der Entschlüsselung mit PDF.js geöffnet. EML und MSG
verarbeitet der vorhandene Parser im Browser; eingebettete Bilder bleiben
möglich, entfernte Bilder sind gesperrt. Bilder, Videos und DWG-Pläne verwenden
ebenfalls lokale Datei-URLs. Diese URLs verlassen den Browser nicht und gelten
nur während der geöffneten Vorschau.

Beim Hochladen erzeugt der Browser Bildvorschauen und liest eingebetteten
PDF-Text aus. Der daraus gewonnene Text wird zusammen mit den Dateimetadaten
verschlüsselt. Es startet dabei kein serverseitiger OCR- oder LLM-Auftrag.
Bildscans ohne eingebetteten Text bleiben deshalb ohne Volltext, solange kein
ausdrücklich aufgerufener Erkennungsvorgang angeschlossen ist.

Die Dateisuche berücksichtigt Dateinamen und vorhandenen extrahierten Text.
Sie verarbeitet deutsche und englische Wortformen, Wortanfänge, Phrasen und
Ausschlüsse lokal in einem Worker. Treffer werden nach ihrer Relevanz sortiert;
Ausschnitte zeigen passende Textstellen mit Hervorhebung. Die
[Dokumentensuche](verschluesselte-dokumentensuche.md) beschreibt die Syntax und
die verbleibenden Unterschiede zur bisherigen PostgreSQL-Suche. Beim ersten
Zugriff müssen die berechtigten Metadaten synchronisiert werden; die
Originaldateien werden erst für die jeweilige Vorschau oder den Download
geladen.

## Speichern und technische Prüfungen

Der Browser zerlegt eine Datei in Blöcke von höchstens 256 KiB und verschlüsselt
jeden Block. Erst nach bestätigter Ablage veröffentlicht er das verschlüsselte
Dateiverzeichnis mit den Hashes und der Reihenfolge aller Blöcke. Ausgetauschte,
fehlende oder umsortierte Blöcke führen beim Lesen zu einem Fehler. Bestätigte
Blöcke lassen sich auch durch einen berechtigten Schreiber nicht überschreiben;
eine Bearbeitung legt neue Blöcke an.

Der Browser überträgt jeweils bis zu vier verschlüsselte Blöcke gemeinsam.
Beim Upload prüft die API die Berechtigung und jede Signatur, speichert die
Blöcke gemeinsam im Datendienst und veröffentlicht ihre Verweise in einer
Transaktion. Anschließend liest der Browser die Gruppe zurück und prüft jeden
Hash. Eine Datei wird erst im Verzeichnis sichtbar, sobald alle Blöcke
bestätigt sind. Bei einem Fehler oder Abbruch beginnt keine weitere Gruppe.
Der Browser wartet auf den laufenden Schreibvorgang, bevor er den Zugriff auf
die Dateischlüssel schließt.

Auch beim Download prüft die API die Leseberechtigung für die Gruppe und
ruft ihre Blöcke gemeinsam beim Datendienst ab. Der Browser prüft die Hashes
in der Reihenfolge des Dateiverzeichnisses.

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

## Vorhandene Dateien aus einer Sicherung übernehmen

Bei der Einrichtung eines neuen Mandanten kann ein gesicherter Dateiordner
zusammen mit der alten SQL-Sicherung ausgewählt werden. Die Webapp ordnet die
Originale ihren Objektpfaden zu und prüft ihre Größen, bevor das erste Konto
registriert wird. Die Dateiübernahme verwendet dieselben verschlüsselten Blöcke
wie neue Uploads. Beim Fortsetzen sucht der Browser gruppenweise nach bereits
abgelegten Blöcken. Er gleicht deren Inhalt mit der lokalen Quelle ab und lädt
nur fehlende Blöcke hoch.

Die Quelle wird ausschließlich lokal gelesen. Eine laufende alte Datenbank,
S3-Schreibfreigaben oder frühere Hintergrundjobs werden dafür nicht
angesprochen. Nach dem signierten Abschluss bleibt das Quellarchiv
unveränderlich; die übernommenen Projektdateien werden über ihre normalen
Projektfreigaben bearbeitet. Die [Bestandsübernahme](bestandsumstellung.md)
beschreibt Dateiauswahl, Benutzerzuordnung und die Grenzen einer reinen
Mandantensicherung.
