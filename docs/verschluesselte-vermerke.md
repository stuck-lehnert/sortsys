# Vermerke zu Baustellen und Stammdaten

Vermerke bleiben direkt beim Projekt, Kunden, Ansprechpartner oder Werkzeug.
Eine Materialfreigabe kann etwa am Projekt stehen, eine Rückrufnotiz beim
Ansprechpartner. Texte und Urheberangaben werden im Browser verschlüsselt und
erst dort wieder gelesen. Die API speichert die signierten Chiffrate.

Vermerke verwenden den Schlüssel ihres jeweiligen Inhaltsbereichs:

| Zuordnung       | Benötigte Freigabe          |
| --------------- | --------------------------- |
| Projekt         | Grunddaten dieses Projekts  |
| Kunde           | Kundenkatalog               |
| Ansprechpartner | Kontaktkatalog              |
| Werkzeug        | Grunddaten dieses Werkzeugs |

Eine Projektfreigabe öffnet keine Notizen anderer Projekte. Der Kunden- und
Kontaktkatalog umfasst dagegen jeweils den gesamten zugehörigen Bestand.
Innerhalb eines Katalogs bleiben die Vermerke ihren einzelnen Datensätzen
zugeordnet. Eine getrennte Vermerkfreigabe innerhalb desselben Inhaltsbereichs
gibt es nicht.

**Lesen**, **Anlegen**, **Bearbeiten** und **Löschen** werden einzeln geprüft.
Mit Lese- und Anlagerecht lässt sich der erste Vermerk auch in einer leeren
Rubrik erstellen. Daraus folgt kein späteres Änderungs- oder Löschrecht. Die
Oberfläche zeigt nur die freigegebenen Aktionen; die Datenadapter und die API
prüfen den tatsächlichen Zugriff erneut. Eine Administratorrolle ersetzt diese
Inhaltsfreigaben nicht.

## Speichern und Bestandsübernahme

Vor dem Speichern prüft der Browser Textlänge, Datenformat und die genaue
Zuordnung. Ein fehlendes oder gelöschtes Projekt, Werkzeug oder Adressbuchobjekt
nimmt keine Vermerke an. Die Speichertransaktion enthält den geprüften Stand des
Elternbereichs. Wird dieser inzwischen gelöscht, kann die Notiz nicht auf Basis
des alten Stands gespeichert werden.

Bearbeiten und Löschen beziehen sich außerdem auf die zuvor gelesene Signatur
des Vermerks. Ändert ein anderer Benutzer denselben Vermerk, wird die veraltete
Änderung abgewiesen. Das gilt auch bei Verbindungen zu unterschiedlichen
API-Instanzen. Eine verlorene Speicherantwort wird durch erneutes Lesen geprüft;
eine bloße Erfolgsmeldung genügt nicht. Eine Löschung hinterlässt eine signierte
Löschmarkierung.

Geöffnete Vermerklisten erhalten technische Änderungshinweise per WebSocket und
lesen anschließend den signierten Stand neu. Die Aktualisierung über zwei
unabhängige API-Prozesse ist ebenfalls geprüft; Vermerktexte gehören nicht in
die Änderungshinweise.

Die Bestandsübernahme kopiert die vollständigen ursprünglichen Zeilen. Sie
erhält Texte, ursprüngliche Urheber, Zeitpunkte und deren Mikrosekunden. Ein
unveränderter Wiederanlauf schreibt bereits bestätigte Notizen nicht neu.
Vermerke werden erst nach ihren Projekten, Werkzeugen und Adressbüchern
übernommen.

Rechteentzug und erneute Freigabe folgen dem Schlüsselwechsel des jeweiligen
Bereichs. Bereits gelesene oder kopierte Texte lassen sich damit nicht
zurückholen. Zwei aufeinanderfolgende Seed-Recoveries sind zusammen mit den
ursprünglichen signierten Vermerken im Test über zwei API-Prozesse geprüft. Die
vollständige Mandantenaktivierung und Bereinigung alter Klartextbestände steht
weiterhin aus.
