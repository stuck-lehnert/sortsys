# Aktionen passend zur Datenfreigabe anzeigen

Produktkatalog, Kunden, Ansprechpartner, Lieferanten, Preisaufzeichnungen,
Projektgrunddaten und Lieferscheine verwenden ihre verifizierten Freigaben auch für die Anzeige
von Menüs und Schaltflächen. Ein Benutzer mit Leserechten sieht die zugehörigen
Ansichten. Mit einer Bearbeitungsfreigabe stehen die passenden Änderungsaktionen
zur Verfügung. Das Anlegen neuer Einträge wird gesondert geprüft.

Eine bisherige Administratorrolle öffnet diese Inhaltsaktionen nicht pauschal.
Sie bleibt für die Verwaltungsoberfläche und die technischen Anmelderollen
maßgeblich. Die Inhaltsfreigabe benötigt weiterhin eine gültige signierte Regel.
Der Browser bindet diese Regel an die bestätigte Identität des angemeldeten
Kontos; eine andere Benutzerkennung aus einer Antwort genügt nicht.

Die Menüanzeige liest dafür nur öffentliche technische Metadaten und signierte
Nachweise. Sie fordert weder Inhaltsschlüssel noch Produkttexte, Preise oder
Dokumente an. Die Datenadapter und die API prüfen jede tatsächliche Aktion
zusätzlich. Eine sichtbare Schaltfläche vergibt kein neues Recht.

## Angebote und Projekte unabhängig anlegen

**Angebot erstellen** verwendet die eigene Freigabe für neue Angebote und
Aufträge. Dafür ist kein vorhandenes Projekt nötig. Das Recht, ein bestehendes
Projekt zu bearbeiten, erlaubt umgekehrt keine neue Angebotsanlage. Die
Freigaben **Neue Projekte anlegen** und **Neue Angebote und Aufträge anlegen**
bleiben unabhängig.

Ein neu angelegtes Projekt oder Angebot erhält seine Zugriffe über den
zertifizierten Anlagenachweis. Die Menüanzeige prüft auch diesen Nachweis.
Wird die Anlageberechtigung später entzogen, bleiben bereits vergebene Zugriffe
auf vorhandene Projekte erhalten.

Auf einer Projektseite richten sich Bearbeiten, Abschließen, Fortsetzen und
Löschen nach der Freigabe genau dieses Projekts. Eine Bearbeitungsfreigabe für
ein anderes Projekt genügt nicht. Der Reiter **Anhänge** benötigt zusätzlich
Lesezugriff auf die Projektdateien. Die Dokumentensuche erscheint bei einer
entsprechenden Dateifreigabe.

## Laufende Aktualisierung

Änderungshinweise über den WebSocket verwerfen die bisherige Menüfreigabe.
Während der Prüfung des neuen Stands bleiben die betroffenen Aktionen gesperrt.
Das funktioniert auch, wenn Verwaltung und Benutzer an unterschiedlichen
API-Instanzen verbunden sind. Ein Kontowechsel verwirft laufende Abfragen;
eine verspätete Antwort kann die alten Aktionen nicht wieder einschalten.
Bei einem Ladefehler lässt sich die Prüfung mit **Erneut versuchen** wiederholen.

Weitere Fachbereiche verwenden bis zu ihrem Anschluss noch die bisherigen
Menürollen. Die vollständige Umstellung umfasst außerdem die feineren Aktionen
innerhalb der Dokumenteditoren und die noch fehlenden Fachadapter. Weitere
Produktverweise aus noch nicht umgestellten Fachbereichen bleiben offen.
