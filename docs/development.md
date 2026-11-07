# Lokale Entwicklung

Mit dem [Schnellstart](../README.md#entwicklung) steht eine vollständige Umgebung
bereit: PostgreSQL, MinIO, API, zwei Hintergrunddienste, Webapp, Euro-Office und
diagrams.net. Euro-Office und diagrams.net starten unabhängig von API und Webapp
und können erst später verfügbar sein.

## Dienste

| Dienst | Standardadresse |
| --- | --- |
| Webapp | <http://127.0.0.1:5173> |
| API | <http://127.0.0.1:3000> |
| PostgreSQL | `127.0.0.1:32532` |
| MinIO | <http://127.0.0.1:39100> |
| Euro-Office | <http://127.0.0.1:39180> |
| diagrams.net | <http://127.0.0.1:39181> |

Ports und Images lassen sich über die `DEV_*`-Variablen am Anfang von
[`scripts/dev`](../scripts/dev) anpassen. `CONTAINER_RUNTIME=docker` beziehungsweise
`podman` wählt die Container-Laufzeit ausdrücklich aus.

## Daten und Protokolle

Jeder Start erstellt die Entwicklungsdatenbanken neu. Dienstdaten und
Abhängigkeits-Caches liegen im ignorierten Verzeichnis `.dev-data/`. Beim Beenden
werden die Container entfernt und diese Ordner erhalten. Beim nächsten Start
werden die Entwicklungsdatenbanken trotzdem zurückgesetzt. Vorhandene
Editordatenbanken bleiben erhalten.

Dienstprotokolle zeigt `docker logs -f sortsys-dev-api` beziehungsweise der
entsprechende Podman-Befehl. Bei fehlgeschlagenem API-Start bleiben der Container
und `.dev-data/logs/api-startup.log` zur Diagnose verfügbar. Der nächste Start
ersetzt den Container. Nicht verfügbare Editoren stoppen die Kernanwendung nicht.

## LLM-Konfiguration

Das Startskript liest die `.env` im Hauptverzeichnis als Daten ein. Ein befüllter
`OPENROUTER_API_KEY` wählt OpenRouter; andernfalls wählt `OPENAI_API_KEY` OpenAI.
`OPENROUTER_MODEL` und `OPENAI_MODEL` überschreiben die Modellvorgaben.
Exportierte Werte haben Vorrang vor `.env`. Die aktuellen Standardwerte stehen
in [`scripts/dev`](../scripts/dev).

## Beispieldaten

Der Mandant `test` enthält fiktive Unternehmensdaten, Benutzer und Projekte sowie
Angebote, Aufmaße und weitere Dokumente in verschiedenen Bearbeitungsständen,
einschließlich aufgemessener X31-Positionen und Rechnungsbeispielen. `john.doe`
ist Administrator, `frank.doe` ein weiterer Beispielbenutzer. Beide verwenden
lokal das Passwort `123456`.

[Dokumentbeispiele](../sortsys-api-v2/seed-assets/README.md) liegen fest im Repository;
das Seeding lädt sie unverändert hoch. Positionsdaten werden zufällig erzeugt.
Mit demselben Zufallsstartwert lässt sich ein Lauf reproduzieren.

Fehlende Dokumentbeispiele zu einem bestehenden, laufenden Entwicklungsmandanten hinzufügen:

```bash
docker exec sortsys-dev-api cargo run --package sortsys-api --bin seed_dev -- --extend-native-documents
```

Dieser ergänzende Lauf verwendet Seed-Manifeste und erhält eigene Änderungen.
Er führt den Datenbank-Reset von `scripts/dev` nicht aus.
