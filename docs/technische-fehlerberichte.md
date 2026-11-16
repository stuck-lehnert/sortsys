# Technische Fehlerberichte

Die Betreiberverwaltung zeigt unter **Fehler** an, in welchem Teil der Anwendung
ein Fehler aufgetreten ist. Eine Meldung nennt den Mandanten, das Benutzerkonto,
die technische Quelle, den Seitenbereich und die Build-Kennung. Ein vorhandener
HTTP-Status hilft beispielsweise, einen fehlenden Zugriff von einem Serverfehler
zu unterscheiden. **Aktualisieren** lädt neu eingegangene Meldungen.

Die Webapp überträgt keine ursprünglichen Fehlermeldungen oder Stacktraces.
Diese könnten Positionstexte, Dateinamen oder Kalkulationswerte enthalten. Die
gemeinsame Meldefunktion nimmt deshalb nur technische Angaben entgegen; freie
Fehlerobjekte gehören nicht zu ihrer Schnittstelle. Aus einer Adresse wie
`/gaeb/<id>?…` wird deshalb nur `/gaeb`. Die Build-Kennung ist ein Commit-Hash
oder `development`; zusätzliche Metadaten werden verworfen. Für die Untersuchung
des eigentlichen Dokumentinhalts wird der Browser benötigt.

Die API prüft dieselben Grenzen erneut. Sie weist unbekannte Quellen und
Seitenbereiche, freie Meldungstexte, Stacktraces sowie zusätzliche Metadaten ab.
Nur angemeldete Benutzer können einen Bericht senden. Die Liste ist
ausschließlich mit dem globalen Betreiberzugang lesbar, auch ein
Mandantenadministrator erhält darauf keinen Zugriff.

Alle API-Instanzen verwenden dasselbe Kontingent: höchstens 20 gespeicherte
Berichte pro Minute und Mandant. Darüber hinausgehende Meldungen werden ohne
erneute Fehlermeldung verworfen. Ein Zähler und der Bericht werden gemeinsam
geschrieben; ein Konflikt zwischen Instanzen wird erneut versucht. Eine
langsamer laufende Serveruhr setzt ein bereits verbrauchtes Kontingent nicht
zurück.

Der gemeinsame Datendienst hält höchstens 1.024 aktuelle Diagnoseeinträge vor.
Neue Berichte ersetzen die ältesten Einträge, die Oberfläche zeigt höchstens 200
davon. Die Fachbelege und ihre signierten Änderungsnachweise verwenden getrennte
Speicherwege.

Der
[native Integrationstest](../sortsys-webapp-v2/scripts/test-operator-telemetry.ts)
prüft zwei API-Instanzen, manipulierte Berichte, verweigerte Zugriffe und das
gemeinsame Kontingent. Die
[Browser-E2E-Suite](../sortsys-webapp-v2/scripts/e2e/development.browser.mjs)
öffnet zusätzlich die Betreiberansicht nach einer tatsächlich verweigerten
Dokumentabfrage.
