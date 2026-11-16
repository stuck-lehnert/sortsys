# Altdaten beim Anlegen eines Mandanten übernehmen

Ein Bauunternehmen kann seine bisherigen Projekte, Angebote, Aufmaße und
Stammdaten aus einer PostgreSQL-Sicherung in einen neuen Mandanten übernehmen.
Die Webapp liest und prüft die Sicherung im Browser und speichert die
übernommenen Daten verschlüsselt. Die bisherige Installation bleibt davon
unberührt. Ein PostgreSQL-Dienst wird im neuen Setup nicht benötigt.

## Den neuen Mandanten einrichten

Die Betreiberverwaltung erstellt einen Einrichtungslink für die neue
Organisation. Über diesen Link lässt sich entweder ein leerer Mandant anlegen
oder eine vorhandene Sicherung auswählen:

1. Unter **Vorhandene Sicherung übernehmen** die bisherige `.sql.gz`- oder
   `.sql`-Datei auswählen. Die lokale Prüfung kontrolliert Feldtypen,
   Pflichtfelder, eindeutige Schlüssel und Beziehungen zwischen den
   Geschäftstabellen.
2. Das bisherige Benutzerkonto für den ersten Administrator auswählen. Seine
   Kennung bleibt erhalten, damit Arbeitszeiten, Zuständigkeiten und historische
   Urheberangaben weiter zu derselben Person gehören.
3. Den zugehörigen Dateiordner auswählen, sofern die Sicherung auf Anhänge
   verweist. Objektpfade müssen erhalten bleiben; die Webapp akzeptiert den
   Objektpfad selbst oder `Bucket/Objektpfad` unter dem gewählten Ordner.
   Fehlende oder mehrdeutige Dateien stoppen die Prüfung vor der Registrierung.
4. Ein neues Passwort festlegen und die erzeugte Wiederherstellungsphrase
   sichern. Das erste Konto erhält die Administratorrolle und die
   kryptografischen Zugriffe für die Einrichtung. Alte Passwörter, Sitzungen und
   Rollen werden nicht als Zugänge oder Freigaben übernommen.
5. Die Übernahme im Browser abschließen. Die Fachansichten bleiben bis dahin
   gesperrt. Weitere Benutzer erhalten anschließend neue Einladungen; ihre
   bisherigen Kennungen und archivierten beziehungsweise deaktivierten
   Kontozustände bleiben erhalten.

Der Browser muss während der Verarbeitung geöffnet bleiben. Nach einer
Unterbrechung lässt sich die Einrichtung fortsetzen: Bereits bestätigte
Zielobjekte werden geprüft und weiterverwendet. Sobald das verschlüsselte
Quellarchiv vollständig vorliegt, ist keine erneute Dateiauswahl nötig. Vor
diesem Zeitpunkt müssen dieselbe Sicherung und derselbe Dateiordner erneut
gewählt werden. Abweichende Quellen überschreiben keinen bestätigten Stand.

## Datenbank und Dateien gehören zusammen

Die bisherige Mandantensicherung enthält Verweise auf Pläne, E-Mails,
GAEB-Dokumente, Druckanlagen und andere Anhänge. Die Dateien selbst liegen in
der separaten Objektablage und müssen ebenfalls gesichert sein. Sie werden über
unveränderliche verschlüsselte Blöcke übernommen; Dateinamen und Objektpfade
bleiben im verschlüsselten Archiv.

Unternehmensanschrift und weitere Angaben aus der früheren Verwaltungsdatenbank
sind in einer reinen Mandantensicherung nicht enthalten. Die Anschrift muss
anschließend unter **Verwaltung → Organisation** ergänzt werden. Auch ein
Einleseverlauf, der ausschließlich in der Verwaltungsdatenbank gespeichert war,
lässt sich daraus nicht wiederherstellen.

Die Webapp übernimmt die Fachdaten über dieselben verschlüsselten Adapter wie
bei der normalen Bearbeitung. Dazu gehören Personal, Abwesenheiten, Produkte,
Kontakte, Werkzeuge, Projekte und deren Dokumente sowie die kaufmännischen
Vorgänge. GAEB-Dateien werden lokal zerlegt und können aus ihren geschützten
Bestandteilen wieder zusammengesetzt werden. Die verschlüsselte SQL-Quelle
bleibt als Nachweis erhalten, einschließlich Daten, die keine eigene Fachansicht
haben. Sie stellt keine zusätzliche Anmeldemöglichkeit bereit.

## Grenzen und technische Prüfung

Lesbar sind textuelle PostgreSQL-Sicherungen mit `COPY`-Datensätzen, auch
Gzip-komprimiert. Binäre `PGDMP`-Archive und nicht unterstützte ältere
Schemastände werden abgewiesen. Unbekannte Geschäftsfelder werden nicht
stillschweigend verworfen. SQL-Anweisungen, Funktionen und psql-Befehle aus der
Datei werden niemals ausgeführt.

Die Absicht zur Backupübernahme ist bereits an das signierte Mandantenzertifikat
gebunden. Ein zweiter Tab kann die Organisation daher nicht vorzeitig als leeren
Mandanten freigeben. Ein signierter Abschlussnachweis verbindet die Übernahme
mit ihrem Quellarchiv. Danach akzeptiert die API weder Änderungen am Archiv noch
neue historische Ursprungsnachweise. Diese Regeln gelten gemeinsam für alle
API-Instanzen.

Eine Signatur bestätigt die Urheberschaft des Nachweises. Sie beweist der API
keine fachliche Richtigkeit verschlüsselter Inhalte; diese prüfen die
entschlüsselnden Clients. Die Mehrinstanztests verwenden den echten
[Produktionsrouter](../sortsys-api-v2/AGENTS.md) und den DuckDB-Datendienst. Sie
prüfen unter anderem eine unterbrochene Übernahme, erhaltene Benutzer-IDs,
Kalkulationskosten, Beschreibungstreffer in der Produktsuche und die bytegenaue
Wiederherstellung einer statischen PDF-Datei. Der vollständige
[Funktionsabgleich](verschluesselung-funktionsabgleich.md) führt die weiterhin
offenen Punkte der Anwendung auf.
