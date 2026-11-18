# Lieferanten und Preisaufzeichnungen

Bei der Materialkalkulation lassen sich vorhandene Lieferanten nach Namen oder
Beschreibung suchen. Lieferanten können angelegt, geändert und gelöscht
werden. Eine Preisaufzeichnung verbindet ein Produkt mit einem Betrag, einem
Zeitpunkt und bei Bedarf einem Lieferanten. Tatsächliche Einkäufe und
Preisangebote bleiben über das vorhandene Kennzeichen unterscheidbar.
Die bisherigen Aufrufe der Oberfläche laufen dafür über den verschlüsselten
Browseradapter; Namen, Beschreibungen, Kommentare und Beträge erreichen die
alte Klartext-API nicht.

Lieferanten, Preisaufzeichnungen und Preisimporte verwenden den
[gemeinsamen Datenkern im Browser](clientseitige-datenlaufzeit.md). Er verwaltet
geprüfte Versionen, das gezielte Nachladen einzelner Datensätze und die atomare
Veröffentlichung zusammengehöriger Änderungen. Der Prüfdialog behält seine
bisherigen Produktzuordnungen und Wiederholungsbelege.

Lieferantendaten liegen in `catalog:vendors:master-data`. Preisaufzeichnungen
verwenden weiterhin `catalog:products:procurement`, getrennt von
Produktbeschreibungen. In der Benutzerverwaltung stehen für beide Bereiche
**Kein Zugriff**, **Lesen** und **Lesen und bearbeiten** zur Auswahl.
Eine Lieferantenfreigabe öffnet keine Preise. Eine reine Preisfreigabe öffnet
weder Produktnamen noch Lieferantenbeschreibungen.

Mit einer Preisfreigabe zum Bearbeiten kann ein Mitarbeiter bestehende Beträge
und Kommentare ändern oder Aufzeichnungen löschen. Werden dabei die bisherigen
Produkt- und Lieferantenverweise beibehalten, benötigt er deren Schlüssel nicht.
Für eine neue Preisaufzeichnung oder einen anderen Produkt- beziehungsweise
Lieferantenverweis muss der Zielbestand zusätzlich lesbar sein. Der Browser
prüft den signierten Eintrag und schließt dessen technischen Versionsstand in
denselben Schreibvorgang ein. Eine zwischenzeitliche Änderung weist die gesamte
Preisänderung zurück. Die API prüft diese Versionen und Berechtigungen; sie
erfährt dabei keinen Preis.

Diese Schreibprüfung hängt nicht von den Bedienelementen ab. Ein Integrationstest
umgeht die Browserprüfungen und erzeugt als Leser neue, korrekt verschlüsselte
und mit der eigenen Identität signierte Pakete. Die API weist sowohl eine
solche Änderung als auch einen signierten Löschauftrag ohne Löschrecht zurück.

Der Browser prüft Datentypen, Kennungen, gültige Zeitpunkte und Textlängen.
Beträge bleiben Gleitkommazahlen entsprechend dem bestehenden Datenmodell;
Zeichenfolgen werden nicht stillschweigend in Zahlen umgewandelt.
Neue Preise, Änderungen und Löschungen werden erst nach erneutem Lesen der
verschlüsselten Daten bestätigt. Eine verlorene Speicherantwort lässt sich so
von einer bloßen Erfolgsantwort ohne gespeicherten Inhalt unterscheiden.
Beim Schreiben werden nur der betroffene Datensatz und gegebenenfalls seine
neuen Zielverweise entschlüsselt, nicht der gesamte Preisverlauf. Die gemeinsame
Versionskontrolle gilt trotzdem für alle beteiligten Bereiche.

## Produkte und Lieferanten löschen

Beim Löschen eines Produkts verschwinden dessen Kategorien und Preisaufzeichnungen
aus den aktiven Listen. Beim Löschen eines Lieferanten bleiben die Preise erhalten;
ihre Lieferantenzuordnung entfällt. Der Löschende braucht dafür nur die entsprechende
Produkt- oder Lieferantenfreigabe, keinen Preisschlüssel. Ein Mitarbeiter mit reiner
Preisfreigabe kann den verbleibenden Preis anschließend weiter bearbeiten.

Jeder dieser Einträge trägt eine signierte Erklärung seiner technischen Kennungen
und Beziehungen. Die Erklärung ist an genau die verschlüsselte Fassung gebunden.
Die API prüft damit, ob ein Preis auf vorhandene Produkte und Lieferanten verweist.
Der Browser prüft zusätzlich, ob diese öffentlichen Verweise mit der entschlüsselten
Zeile übereinstimmen. Namen, Beschreibungen und Beträge bleiben verschlüsselt.

Beim Lesen fordert der Browser die Erklärungen für jeweils höchstens 64 Einträge
an. Vier solche Abrufe können eine HTTP-Anfrage teilen; anschließend werden
höchstens 16 Signaturen gleichzeitig geprüft. Für 320 Einträge sind dadurch zwei
HTTP-Anfragen für diese Nachweise nötig. Erst nach der vollständigen Prüfung
erhält die geladene Sammlung ihre bestätigten Beziehungen. Fehlt ein Nachweis
oder widerspricht er einer verschlüsselten Zeile, wird die gesamte Prüfung
abgebrochen. Bereits laufende Abrufe werden dabei vor der Fehlerbehandlung
abgeschlossen.

Ein Löschauftrag nennt die aktuelle Objektfassung und wird vom Konto signiert.
Eine gemeinsame Transaktion sperrt die betroffenen Bereiche über alle API-Instanzen.
Bei einer Lieferantenlöschung wird der Preistext nicht neu geschrieben: Der Leser
leitet die entfallene Zuordnung aus dem signierten Löschbeleg ab. Preislisten erhalten
dafür einen eigenen technischen Änderungshinweis. Eine spätere Schreibanfrage kann
gelöschte Objekte nicht wiederbeleben. Nach verlorener Bestätigung lässt sich der
Löschbeleg erneut lesen; eine Erfolgsantwort allein genügt nicht.

Die Löschung ist bisher logisch. Alte verschlüsselte Fassungen und Sicherungen
werden dadurch noch nicht bereinigt. Weitere Produktverweise, etwa aus Lieferscheinen
und Regieberichten, müssen mit deren noch ausstehenden Fachadaptern angeschlossen
werden.

Die Übernahme der Lieferanten verwendet das geprüfte verschlüsselte Archiv und
behält Kennungen, Namen, Beschreibungen und Zeitstempel bei. Ein erneuter Versuch
vergleicht bereits vorhandene Einträge. Preisaufzeichnungen werden weiterhin mit
dem Produktbestand übernommen. WebSocket-Hinweise aktualisieren freigegebene
Lieferanten- und Preislisten auch über unabhängige API-Instanzen. Sie enthalten
keine Namen oder Beträge. Ein Kontowechsel verwirft geladene Inhalte und wartende
Arbeiten.

## Preise aus einer Liste oder Rechnung übernehmen

Der vorhandene Prüfdialog ordnet erkannte Preiszeilen bestehenden Produkten zu
oder legt daraus neue Produkte an. Der Browser prüft Nettopreise, Basiseinheiten
und Umrechnungen. Neue Produkte erhalten fortlaufende Artikelnummern. Eine
zwischenzeitlich geänderte Basiseinheit muss vor dem Speichern erneut geprüft
werden; ein bereits bekanntes Produkt wird durch den Preisimport nicht umbenannt.

Produkte, Preisaufzeichnungen und ein verschlüsselter Ausführungsbeleg werden
zusammen veröffentlicht. Größere Listen lädt der Browser vorher in begrenzten
verschlüsselten Paketen hoch. Diese Pakete sind noch kein sichtbarer Produkt-
oder Preisbestand. Erst eine Transaktion prüft die aktuellen Berechtigungen und
gelesenen Versionen und übernimmt den gesamten Import. Upload und Veröffentlichung
dürfen über verschiedene API-Instanzen laufen.

Eine Wiederholung im gleichen Dialog verwendet denselben Auftrag. Geht die
Antwort verloren, kann der Browser den Beleg nachlesen, statt dieselben Preise
erneut anzulegen. Geänderte Eingaben erhalten einen neuen Auftrag. Der Beleg
enthält die Anzahl neuer Produkte und Preisaufzeichnungen sowie eine mit einem Kontogeheimnis
berechnete Prüfsumme. Ein einfacher Hash der Produktbeschreibungen wäre hier
ungeeignet, weil reine Preisleser damit mögliche Beschreibungstexte ausprobieren
könnten. Produkttexte bleiben in ihrem eigenen Schlüsselbereich.

Die vorbereiteten Upload-Pakete bleiben bisher auch nach der Veröffentlichung
als verschlüsselte Daten im Speicher liegen. Ihre Bereinigung gehört zur noch
ausstehenden Speicherbereinigung.

Die lokale Suche berücksichtigt
Wortanfänge und Beschreibungen; Suchsprache und Sortierung sind noch nicht
vollständig mit PostgreSQL abgeglichen. Insbesondere Sonderzeichen können
Lieferantennamen anders einsortieren. Die unterstützten Menüs verwenden inzwischen
die [verifizierten Datenfreigaben](menues-und-datenfreigaben.md). Für eine
Preisaufzeichnung innerhalb der Produktdetailansicht muss zusätzlich der
Produktkatalog lesbar sein.
