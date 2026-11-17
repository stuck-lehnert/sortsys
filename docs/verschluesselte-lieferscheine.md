# Lieferscheine mit getrennten Mengen- und Preisfreigaben

Lieferscheine lassen sich verschlüsselt übernehmen, anlegen und bearbeiten.
Listen, Detailansichten und die Kostenberechnung laufen im Browser. Das Löschen
und das Verschieben zwischen Projekten sind noch nicht angeschlossen. Diese
Aktionen werden für geschützte Mandanten vor dem HTTP-Aufruf gesperrt.

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
Produktbeschreibungen und Lieferantennamen werden für diese Rechnung nicht
entschlüsselt.

Änderungen an Mengen oder Kommentaren erhalten die nicht freigegebenen Preise.
Ein bearbeiteter Sonderposten behält seine Kennung; eine Preisänderung wird im
getrennten Preisbereich gespeichert. Die ursprünglichen Formularversionen
verhindern, dass eine ältere Ansicht zwischenzeitliche Änderungen überschreibt.

Die API vergibt die sichtbare Lieferscheinnummer transaktional über alle
Instanzen. Ein signierter, verschlüsselter Beleg bindet die Anlage an ihre
Anfragekennung und die geprüften Eingaben. Eine wiederholte Anfrage nach einem
Verbindungsabbruch erzeugt dadurch keinen zweiten Lieferschein. Mengen,
Sonderpostenpreise und der Anlagebeleg werden gemeinsam veröffentlicht.

Die Kostenberechnung verwendet den letzten Preis vor oder zum Lieferdatum. Fehlt
ein solcher Preis, gilt der erste spätere Preis. Bei identischen Zeitstempeln
entscheidet die numerische Kennung wie in der bisherigen API. Die Auswahl
berücksichtigt Mikrosekunden vor der Umwandlung in JavaScript- Datumswerte.
Mengen und Preise bleiben Gleitkommazahlen entsprechend dem bisherigen
Datenmodell; eine Umstellung der kaufmännischen Rechnung auf exakte Dezimalwerte
ist damit nicht erfolgt.

## Was beim Öffnen geprüft wird

Signaturen und Verschlüsselung binden jeden Lieferschein an Mandant, Projekt,
Inhaltsbereich, Autor und Version. Der Browser prüft anschließend die Zeilen
gegen das abgeleitete Fachdatenmodell. Eine Position mit einer fremden
Lieferscheinkennung, ein zusätzliches Feld oder ein Preis im Mengenbereich
verwirft die gesamte geladene Liste. Unbekannte Inhalte werden nicht
stillschweigend übersprungen. Auch doppelte Positionskennungen und doppelte
laufende Nummern im gelesenen Bestand werden zurückgewiesen.

Die lokale DuckDB prüft Beziehungen innerhalb des freigegebenen Mengenbestands.
Die privaten Produkt-, Benutzer- und Projektgrunddaten gehören zu anderen
Schlüsselbereichen und werden dafür nicht zusätzlich geöffnet. Deren Existenz
wird beim Anlegen über die zusätzlich gelesenen Projekt- und Produktstände
geprüft. Deren Versionen gehen in die Veröffentlichung ein. Die vollständige
Übernahme der bisherigen Löschkaskaden und die Anbindung der Personalverwaltung
fehlen noch. Die API kann fachlich falsche, aber gültig signierte Geheimwerte
weiterhin nicht erkennen.

Mengen und Sonderpostenpreise werden getrennt geladen. Bevor ein neuer Bestand
sichtbar wird, prüft der Leser die gelesenen Bereichsversionen erneut. Eine
zwischenzeitliche Änderung startet den Abruf neu. Technische Ereignisse über den
gemeinsamen PostgreSQL-Transport aktualisieren abonnierte Ansichten auch dann,
wenn die schreibende und die lesende Verbindung verschiedene API-Instanzen
verwenden. Kontowechsel verwerfen den bisherigen RAM-Bestand.

Die Bestandsübernahme kopiert Originalkennungen, Lieferdatum, Mengen, Einheiten
und Kommentare aus dem bereits geprüften Archiv. Der Preiswert wird aus der
Mengenzeile entfernt und unter einem anderen Schlüssel gesichert. Eine erneute
Übernahme prüft vorhandene Zielobjekte, statt sie zu überschreiben. Das alte
Archiv und die gesperrten Klartexttabellen bleiben bis zur vollständigen
Mandantenumstellung erhalten.

Der [Integrationstest](../sortsys-webapp-v2/scripts/test-live-delivery-notes.ts)
vergleicht die übernommenen Werte und historischen Kosten mit der bisherigen
API. Er prüft getrennte Projekt- und Preisrechte, gültig signierte fehlerhafte
Inhalte und Änderungen über zwei API-Instanzen. Die anschließende
Wiederherstellung läuft ohne vorhandene Anmeldung oder entsperrtes Konto mit der
Seed-Phrase; die verbrauchte Phrase wird danach zurückgewiesen. Der
[Schreibtest](../sortsys-webapp-v2/scripts/test-live-delivery-writes.ts) ergänzt
konkurrierende Anlagen über zwei Instanzen, verlorene und fälschlich bestätigte
Antworten, erhaltene Positionskennungen, nicht lesbare Preise und veraltete
Formularstände.
