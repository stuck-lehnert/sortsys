# Lieferscheine mit getrennten Mengen- und Preisfreigaben

Lieferscheine lassen sich verschlüsselt anlegen, bearbeiten und löschen. Listen,
Detailansichten und die Kostenberechnung laufen im Browser. Eine falsch
zugeordnete Lieferung lässt sich im Bearbeitungsdialog einem anderen Projekt
zuweisen. Nummer, Link und Positionskennungen bleiben dabei erhalten.

Eine Baustellenmitarbeiterin kann die gelieferten Materialien und Sonderposten
eines freigegebenen Projekts sehen, ohne dessen Einkaufspreise zu erhalten.
Dafür verwendet der Lieferschein einen eigenen Mengenbereich des Projekts
(`project:<id>:delivery-notes`, Feldbereich `master-data`). Die
Projektgrunddaten allein öffnen diesen Bereich nicht. In der Benutzerverwaltung
lässt sich der Zugriff unter **Lieferscheine** getrennt vergeben. Regieberichte
und Bautagesberichte bleiben unabhängig.

Preise für Sonderposten liegen im eigenen Preisbereich der Lieferscheine
(`procurement` innerhalb desselben Lieferscheinbereichs). **Lieferscheinpreise**
öffnet weder die Weitervergaben des Projekts noch deren Angebotspreise. Eine
reine Mengenfreigabe fordert weder diesen Schlüssel noch die verschlüsselten
Lieferscheinpreise an. Ohne Preisfreigabe zeigt der normale Datenzugriff für
Sonderposten `null`; die Kostenabfrage wird verweigert. Für Materialkosten ist
zusätzlich die getrennte Freigabe der Produktpreisaufzeichnungen erforderlich.

Änderungen an Mengen oder Kommentaren erhalten die nicht freigegebenen Preise.
Ein bearbeiteter Sonderposten behält seine Kennung; eine Preisänderung wird im
getrennten Preisbereich gespeichert. Die ursprünglichen Formularversionen
verhindern, dass eine ältere Ansicht zwischenzeitliche Änderungen überschreibt.

Beim Projektwechsel braucht das Konto im Ausgangsprojekt Änderungsrecht für
Mengen und Leserecht für Preise. Im Zielprojekt braucht es Lese- und
Anlagerechte für beide Bereiche. Das Formular bietet ein Ziel an, wenn diese
Freigaben vorliegen. Mit einer reinen Mengenfreigabe bleibt die Bearbeitung im
bisherigen Projekt möglich. Der Browser übernimmt auch die unveränderten Preise
und verschlüsselt beide Bereiche für die neuen Empfänger. Die API prüft die
signierten Pakete und die gelesenen Versionsstände beider Projekte in derselben
Transaktion, in der sie die Zuordnung wechselt. Alte verschlüsselte Fassungen
bleiben unter ihren bisherigen Schlüsseln gespeichert. Bei einer Rückkehr in
das frühere Projekt erhält der Lieferschein einen neuen Versionsstand.
Bei der Wiederherstellung gilt die Projektzuordnung aus der ausgewählten
Sicherung. Die Nummer bleibt auch nach der Wiederherstellung reserviert.

## Nummerierung und Löschung

Die API vergibt die sichtbare Lieferscheinnummer transaktional über alle
Instanzen. Ein signierter, verschlüsselter Beleg bindet die Anlage an ihre
Anfragekennung und die geprüften Eingaben. Eine wiederholte Anfrage nach einem
Verbindungsabbruch erzeugt dadurch keinen zweiten Lieferschein. Mengen,
Sonderpostenpreise und der Anlagebeleg werden gemeinsam veröffentlicht.

Zum Löschen sind Leserecht und Löschrecht im Mengenbereich nötig. Ein
Änderungsrecht oder ein Schlüssel für Einkaufspreise ist dafür nicht nötig.
Die Bestätigung im Dialog gilt für die dort angezeigte Fassung. Eine
zwischenzeitliche Änderung erfordert eine neue Bestätigung.

Der Client veröffentlicht einen signierten, verschlüsselten Löschdatensatz.
Danach erscheinen weder der Lieferschein noch seine Sonderpostenpreise in den
aktuellen Listen und Berechnungen. Derselbe Servervorgang erhöht die
Änderungsstände beider Bereiche und erzeugt deren Hinweise für verbundene
Clients. Auch eine bereits begonnene Preisabfrage muss dadurch ihren alten
Stand verwerfen. Die Preise müssen für die Löschung nicht entschlüsselt oder
neu verschlüsselt werden.

Die Nummer bleibt vergeben. Alte verschlüsselte Fassungen und die Zuordnung
der Nummer bleiben gespeichert; dies ist keine physische Datenbereinigung.
Eine spätere Schreibanfrage kann weder den Lieferschein noch seine Preise
wiederbeleben. Nach einer verlorenen Antwort prüft der Client den tatsächlich
gespeicherten Löschdatensatz. Eine bloß fehlende Antwort oder ein fehlender
Listeneintrag reicht als Erfolgsnachweis nicht aus.

## Prüfung beim Öffnen

Signaturen und Verschlüsselung binden jeden Lieferschein an Mandant, Projekt,
Inhaltsbereich, Autor und Version. Der Browser prüft anschließend die Zeilen
gegen das abgeleitete Fachdatenmodell. Eine Position mit einer fremden
Lieferscheinkennung, ein zusätzliches Feld oder ein Preis im Mengenbereich
verwirft die gesamte geladene Liste. Auch doppelte Positionskennungen und
doppelte laufende Nummern im gelesenen Bestand werden zurückgewiesen.

Für die Lieferscheinliste eines Projekts prüft der Browser die Freigaben für
Mengen und Preise gemeinsam. Die Nummernzuordnungen liest die API in Paketen
von bis zu 64 Einträgen aus DuckDB. Der Browser kann mehrere solcher Pakete
in derselben HTTP-Anfrage anfordern. Die Prüfung jeder Projektfreigabe und
Nummernzuordnung bleibt Bestandteil des Abrufs.

Die lokale DuckDB prüft Beziehungen innerhalb des freigegebenen Mengenbestands.
Die privaten Produkt-, Benutzer- und Projektgrunddaten gehören zu anderen
Schlüsselbereichen und werden dafür nicht zusätzlich geöffnet. Beim Anlegen
liest der Browser den Projektstand und die benötigten Produkte in Paketen.
Mehrere Positionen mit demselben Produkt teilen sich dessen Prüfung. Projekt-
und Katalogstand gehen in die Versionsprüfung beim Speichern ein. Die API kann
fachlich falsche, aber gültig signierte Geheimwerte weiterhin nicht erkennen.

Die Kostenberechnung verwendet den letzten Preis vor oder zum Lieferdatum.
Fehlt ein solcher Preis, gilt der erste spätere Preis. Bei identischen
Zeitstempeln entscheidet die numerische Kennung. Die Auswahl berücksichtigt
Mikrosekunden vor der Umwandlung in JavaScript-Datumswerte. Mengen und Preise
bleiben Gleitkommazahlen; exakte kaufmännische Dezimalrechnung ist damit nicht
umgesetzt.

Der [native Lieferscheintest](../sortsys-webapp-v2/scripts/test-duckdb-delivery.ts)
prüft Anlage und Bearbeitung mit echten verschlüsselten Datensätzen über zwei
getrennte API-Prozesse. Der Projektwechseltest sichert einen verschobenen
Lieferschein, verschiebt ihn erneut und löscht ihn. Anschließend prüft er die
Vorschau und die Wiederherstellung der gespeicherten Zuordnung. Der
[Löschtest](../sortsys-webapp-v2/scripts/test-native-delivery-deletion.ts) ergänzt
veraltete Bestätigungen, falsche und verlorene Antworten, wiederholte Löschungen,
unverändert vergebene Nummern und abgewiesene Wiederbelebungsversuche. Er prüft
außerdem eine Mengenfreigabe ohne Preiszugriff: Lesen allein erlaubt keine
Löschung; ein zusätzliches Löschrecht benötigt weder Preis- noch
Änderungsrechte. Auch ein korrekt verschlüsselter und vom Leser signierter
Löschversuch direkt gegen die API wird abgewiesen. Der
[Seitentest](../sortsys-webapp-v2/scripts/test-native-delivery-pagination.ts)
prüft 36 verschlüsselte Lieferscheine mit Preisobjekten: Nach 32 Löschungen ist
die erste Preisseite vollständig ausgeblendet; die vier verbliebenen Datensätze
sind trotzdem mit gültigen Signaturen erreichbar.
Diese Testclients aktualisieren ihre Ansichten ausdrücklich;
eine sichtbare Live-Aktualisierung im Browser ist damit nicht belegt.
