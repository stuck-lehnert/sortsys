# Änderungen in mehreren geöffneten Ansichten

Ändert eine zweite Anmeldung einen Produkt-, Kunden- oder Kontakteintrag,
aktualisieren offene Listen ihren lokalen Bestand. Neu angelegte Chats
erscheinen auch in einer weiteren Anmeldung desselben Benutzers. Beim Einlesen
erhält die Verlaufsliste auf diesem Weg den gespeicherten Stand. Dafür fragt die
Webapp keine fachlichen Status-Endpunkte in einer Schleife ab.

Die dauerhafte WebSocket-Verbindung überträgt Änderungshinweise. Darin stehen
Bereichskennungen und technische Speicherstände, keine Produktbeschreibungen,
Preise, Chattexte oder Dateiinhalte. Die Webapp liest anschließend die
benötigten verschlüsselten Objekte und prüft deren Signaturen. Ein Hinweis
allein erlaubt weder eine Fachänderung noch die Übernahme ungeprüfter Daten.

Produkte, Lieferanten, Organisationseinstellungen, Kunden, Kontakte, Projekte
und die Leseansicht der Lieferscheine verwenden dafür bereits den
[gemeinsamen Datenkern im Browser](clientseitige-datenlaufzeit.md). Dieser führt
Speicherstände, lokale Zeilen und Invalidierung zusammen, auch wenn mehrere
Ansichten denselben API-Client verwenden.

## Verbindung und Wiederaufnahme

Eine angemeldete Webapp beantragt eine kurzlebige Eintrittskarte. Beim Öffnen
der Verbindung beantwortet sie eine zufällige Herausforderung mit ihrer
Kontosignatur. Ein abgefangener Nachweis gilt damit nicht für eine neue
Verbindung. Die Eintrittskarte kann über eine andere API-Instanz eingelöst
werden; beide Instanzen prüfen Sitzung, bestätigte Identität und aktuelle
Wiederherstellungsgeneration gegen denselben Bestand.

Pro aktivem Mandanten und API-Prozess besteht ein gemeinsamer Abruf des
dauerhaften Änderungsjournals im DuckDB-Datendienst. Mehrere Browser teilen
diesen Abruf. Die Anfrage wartet bis zu 25 Sekunden auf einen neuen Stand; dabei
hält sie keine Datenbanksperre. Erst der Commit einer Transaktion liefert ihren
Hinweis. Die API fasst kurze Folgen von Hinweisen zusammen und meldet Bereiche
nach den für diese Verbindung bestätigten Lesefreigaben. Ein privater Verlauf
eines anderen Benutzers liefert keinen Bereichshinweis an dieses Konto. Nach dem
Schließen des letzten Browsers wird der gemeinsame Abruf beendet.

Der erste Verbindungsaufbau gleicht den aktuellen Stand ab, ohne eine bereits
gestartete LLM-Verarbeitung abzubrechen. Bei einer Wiederverbindung bleiben
laufende Anfragen erhalten, solange sich die eigenen Freigaben nicht geändert
haben.

Bei einem Verbindungsabbruch verbindet sich der Browser erneut und liest den
aktuellen Stand. Auch die API meldet nach einer unterbrochenen Verbindung zum
Datendienst einen erneuten Abgleich. Das dauerhafte Journal liefert die seitdem
bestätigten Änderungen nach. Überlaufende Warteschlangen führen ebenfalls zu
einem Abgleich. Die Warteschlangen enthalten nur technische Hinweise.

Kennt der lokale Produktspeicher einen gemeldeten Stand bereits, wird seine
Browser-Datenbank nicht erneut aufgebaut. Das vermeidet insbesondere den
doppelten Aufbau nach einer eigenen Speicherung. Ein Chat-Hinweis löst keinen
Neuaufbau des Produktkatalogs aus.

Auch eine geänderte Regelversion verlangt nicht automatisch einen Neuaufbau
unveränderter Fachdaten. Die Webapp prüft Freigaben und Bereichsdefinitionen
erneut und vergleicht den technischen Datenstand mit dem bereits geprüften
Bestand. Erst geänderte Inhalte werden erneut entschlüsselt und projiziert. Der
geprüfte Bestand wird dabei getrennt vom Rückgabestand einer laufenden
Speicherung geführt, damit eigene Änderungen weiterhin vollständig nachgelesen
werden.

Ein Wechsel der Fachfreigaben verwirft die betroffenen Datenzugriffe. Die
angemeldete Oberfläche und der Dialog zur Berechtigungsverwaltung bleiben dabei
bestehen. Die Verwaltung prüft nach dem Speichern die Freigaben des bearbeiteten
Kontos erneut. Fachdialoge mit abgelaufener Datenfreigabe schließen sich.

## Berechtigungen und laufende Arbeit

Entzogene eigene Rechte verwerfen die lokalen Zugriffskontexte und deren
Bereichsschlüssel. Laufende LLM-Anfragen mit dem bisherigen Zugriffskontext
werden abgebrochen. Abonnierte Ansichten lesen ihre Freigaben und Inhalte
erneut. Ein neuer Schlüsselstand wird erst nach Prüfung der signierten
Bereichsdefinition verwendet. Bereits kopierte Inhalte lassen sich durch diesen
Ablauf nicht zurückholen.

Änderungen an den Rechten anderer Konten laden die aktuelle Regelversion nach,
ohne den eigenen laufenden Chat- oder Dokumentkontext allein deswegen
abzubrechen. Zusätzliche eigene Rechte beenden einen bereits erlaubten Kontext
ebenfalls nicht. Sitzung und Freigaben werden außerdem alle 30 Sekunden erneut
geprüft. Das sind Prüfungen technischer Zugangsdaten; Fachinhalte werden dabei
nicht abgefragt. Jeder Datenabruf und jede Speicherung prüft die aktuellen
Freigaben weiterhin unabhängig vom Hinweis. Eine ungültig gewordene Sitzung oder
Wiederherstellungsgeneration beendet die Verbindung.

Der Kanal ist an Produktkatalog, Kunden, Ansprechpartner, Projektgrunddaten,
[Projektdateien](verschluesselte-projektdateien.md) und persönliche KI-Verläufe
angeschlossen. Geöffnete GAEB-Dateien erhalten darüber gespeicherte Dateistände.
Die verschlüsselte gemeinsame GAEB-, Office- und Diagrammbearbeitung benötigt
zusätzlich ihre Fachadapter und verschlüsselte Editor-Updates. Diese
Dokumentbearbeitung ist durch den Ereigniskanal allein noch nicht umgesetzt.

Der [native Mehrinstanztest](../sortsys-webapp-v2/scripts/test-native-events.ts)
prüft drei gleichzeitige Verbindungen, die Signatur bei der Anmeldung,
Änderungshinweise, den Entzug und die erneute Vergabe von Leserechten sowie
das Schließen einer abgemeldeten Sitzung. Der
[Chromium-Test](../sortsys-webapp-v2/scripts/e2e/development.browser.mjs) prüft,
dass ein erneuter Datenabgleich die Produktliste im geöffneten Zustand erhält.
