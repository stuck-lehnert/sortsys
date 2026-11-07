# Bereitstellung und Betrieb

sortsys lässt sich aus dem Quellcode oder mit veröffentlichten Images betreiben.
Dafür stehen [Compose mit lokalem Build](../compose.yaml) und
[Compose mit GHCR-Images](../ghcr-compose.yaml) bereit. Lokal beginnen:

```bash
cp .compose-env.example .compose-env
# Konfiguration und Geheimnisse ergänzen.
docker compose --env-file .compose-env up -d
```

[.compose-env.example](../.compose-env.example) beschreibt die Betriebsvariablen,
die [API-Konfiguration](../sortsys-api-v2/README.md#laufzeitkonfiguration) die
Servereinstellungen. Mandantendateien und Sicherungen benötigen einen externen
S3-kompatiblen Speicher; das produktive Compose enthält kein MinIO.

## Coolify und öffentlicher Zugriff

Beide Compose-Dateien können mit Coolify eingesetzt werden. Coolify erzeugt und
speichert die konfigurierten `SERVICE_*`-Geheimnisse. `ADMIN_HASH` muss als
bcrypt-Hash des globalen Administratorpassworts angegeben werden. Als literalen
Wert markieren, damit `$`-Zeichen erhalten bleiben.

Weise `webapp` eine öffentliche HTTPS-Domain zu. Sie vermittelt die API und die
Editorpfade `/office/` und `/drawio/`. Dokumentenserver-Ports bleiben intern.
Die Startbereitschaft von Euro-Office und diagrams.net blockiert die Kernanwendung nicht.

## Editor-Geheimnisse und Aktualisierungen

Euro-Offices `JWT_SECRET` und `ONLYOFFICE_JWT_SECRET` der API müssen übereinstimmen.
Beide verwenden `SERVICE_BASE64_64_ONLYOFFICE`, getrennt vom API-Sitzungsgeheimnis
`SERVICE_BASE64_64_JWT`. Für lokales Compose ist ein zufälliges Editor-Geheimnis
mit mindestens 32 Zeichen erforderlich. Vor einem Wechsel aktive Dokumente
speichern und schließen.

Der Dienstname `onlyoffice` und die Variablen `ONLYOFFICE_*` bezeichnen die
kompatible DocsAPI-Anbindung von Euro-Office. `ONLYOFFICE_IMAGE` überschreibt das
festgelegte Standardimage. Anforderungen an Ressourcen und persistente Pfade
beschreibt die [Installationsanleitung des Herstellers](https://euro-office.github.io/documentation/installation/docker/).

Beim Umstieg einer älteren ONLYOFFICE-Installation aktive Dokumente speichern und
schließen sowie Konfiguration und Volumes sichern. Euro-Office verwendet eigene
`euro-office-*`-Volumes; alte Editor-Caches und Datenbanken werden nicht migriert.
Mandantendokumente bleiben in S3. Die bisherigen Volume-Zuordnungen für eine
Rückkehr zur alten Installation aufbewahren.

## Laufzeitanforderungen

Die Webapp verwendet ein schreibgeschütztes Wurzeldateisystem. Generierte
Nginx-Konfiguration und gepufferte Anfragen liegen unter `/tmp`.
`WEBAPP_TMPFS_SIZE` (Standard `256m`) muss zu `CLIENT_MAX_BODY_SIZE` und gleichzeitig
laufenden Uploads passen. `net.ipv4.ip_unprivileged_port_start=0` erlaubt Nginx
innerhalb seines Netzwerk-Namensraums Port 80 ohne Root-Rechte. Andere Umgebungen
benötigen diese Einstellung oder angepasste Listener- und Proxy-Ports.

API und Hintergrunddienst benötigen beschreibbaren temporären Plattenspeicher für
Datenbanksicherungen, Wiederherstellung und OCR. Für mehrere API-Instanzen hinter
einem Load Balancer gilt [Skalierung und Zusammenarbeit](../sortsys-api-v2/README.md#skalierung-und-zusammenarbeit).

## Veröffentlichungen und Rückkehr zu älteren Ständen

Der [Veröffentlichungsablauf](../.github/BRANCHES.md) stellt API-, Hintergrunddienst-
und Webapp-Images bereit. `ghcr-compose.yaml` verwendet standardmäßig `latest`.
Für reproduzierbare Installationen `SORTSYS_API_IMAGE`, `SORTSYS_JOBRUNNER_IMAGE`
und `SORTSYS_WEBAPP_IMAGE` auf denselben Stand festlegen, bevorzugt per Digest.

Persistente Daten vor Aktualisierungen sichern. Volumes beim Image-Wechsel
behalten; `compose down --volumes` löscht Daten. Größere Datenbankversionswechsel
erfordern das [dokumentierte Migrationsverfahren](runtime-upgrades.md#postgresql-17--18-migration).
