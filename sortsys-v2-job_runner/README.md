# Hintergrunddienst

Der sortsys-Hintergrunddienst übernimmt Medien- und Dokumentaufgaben außerhalb
des API-Prozesses: Vorschaubilder, Unternehmenslogos, PDF-Text und OCR.
Über `/internal/job-runners/ws` erhält er befristete Aufträge, lädt Quellen über
signierte URLs, speichert Ergebnisse und meldet Erfolg oder Fehler zurück.

## Lokal ausführen

```bash
go test ./...

JOB_RUNNER_WS_URL=ws://127.0.0.1:3000/internal/job-runners/ws \
JOB_RUNNER_TOKEN=dev-job-runner-token \
go run ./cmd/job-runner
```

`scripts/dev` im Hauptverzeichnis startet zwei Dienste mit automatischem Neustart
bei Quelländerungen. Beide bearbeiten Medien- und OCR-Aufträge.

## Konfiguration

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `JOB_RUNNER_WS_URL` | erforderlich | WebSocket-Adresse der API |
| `JOB_RUNNER_TOKEN` | erforderlich | gemeinsames, auch in der API hinterlegtes Token |
| `JOB_RUNNER_ID` | zufällig | feste Kennung dieser Instanz |
| `JOB_RUNNER_WS_IGNORE_PROXY` | `false` | `HTTP_PROXY` und `HTTPS_PROXY` für die API-Verbindung umgehen |
| `JOB_RUNNER_LEASE_SEC` | `90` | gewünschte Zuweisungsdauer, mindestens 5 Sekunden |
| `JOB_RUNNER_POLL_LIMIT` | `10` | Aufträge je Abfrage, begrenzt auf 1–50 |
| `JOB_RUNNER_POLL_INTERVAL_MS` | `800` | Abstand zwischen Abfragen, mindestens 100 ms |
| `JOB_RUNNER_JOB_TYPE` | `project_file_thumbnail_generate,tenant_logo_generate,delivery_note_ocr,project_file_pdf_extract` | akzeptierte Auftragstypen, durch Komma getrennt |
| `JOB_RUNNER_JPEG_QUALITY` | `85` | JPEG-Qualität, begrenzt auf 60–95 |
| `JOB_RUNNER_RETRY_AFTER_SEC` | `60` | Wartezeit nach Fehlern, mindestens 5 Sekunden |
| `JOB_RUNNER_USER_AGENT` | `sortsys-v2-job-runner/0.1` | Benutzerkennung des WebSocket-Clients |

## Container-Image

```bash
docker build -t sortsys-job-runner:local .
```

Das Image enthält Poppler, ImageMagick und Tesseract mit deutschen und englischen
Sprachdaten sowie einer Erkennung der Leserichtung. Bei Fotos wird neben der
EXIF-Orientierung auch die Richtung des Textes berücksichtigt, damit seitlich
fotografierte Belege aufrecht gelesen werden. PDF-Aufträge verwenden zuerst
vorhandenen Text; lokale OCR folgt nur bei Bedarf für gescannte Seiten und Bilder.

Der Dienst läuft ohne Root-Rechte. Er erhält kurzlebige signierte Download-URLs,
jedoch keine Mandantendatenbank-Zugänge oder LLM-API-Schlüssel.

## Lizenz

Für diesen Dienst gilt die [GNU Affero General Public License v3.0 only](../LICENSE).
