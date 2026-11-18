# Bereitstellung und Betrieb

sortsys lässt sich aus dem Quellcode oder mit veröffentlichten Images betreiben.
Dafür stehen [Compose mit lokalem Build](../compose.yaml) und
[Compose mit GHCR-Images](../ghcr-compose.yaml) bereit. Lokal beginnen:

```bash
cp .compose-env.example .compose-env
# Konfiguration und Geheimnisse ergänzen.
docker compose --env-file .compose-env up -d
```

[.compose-env.example](../.compose-env.example) beschreibt die
Betriebsvariablen, die
[API-Konfiguration](../sortsys-api-v2/README.md#laufzeitkonfiguration) die
Servereinstellungen. Der DuckDB-Dienst verwaltet verschlüsselte Inhalte und
technische Metadaten in Mandantendateien. Der neue Aufbau benötigt keinen
laufenden PostgreSQL-Dienst. Die [Bestandsübernahme](bestandsumstellung.md)
beschreibt den optionalen Backupweg; der
[Funktionsabgleich](verschluesselung-funktionsabgleich.md) führt die offenen
Punkte der Anwendung auf.

## Coolify und öffentlicher Zugriff

Beide Compose-Dateien können mit Coolify eingesetzt werden. Coolify erzeugt und
speichert die konfigurierten `SERVICE_*`-Geheimnisse. `ADMIN_HASH` muss als
bcrypt-Hash des globalen Administratorpassworts angegeben werden. Als literalen
Wert markieren, damit `$`-Zeichen erhalten bleiben.

`webapp` benötigt eine öffentliche HTTPS-Domain. Sie vermittelt die API und den
Editorpfad `/drawio/`. Für den Office-Dienst werden zwei weitere HTTPS-Origins
auf dessen Port `8080` geroutet: `OFFICE_PUBLIC_ORIGIN` und
`OFFICE_SANDBOX_ORIGIN`. `SORTSYS_PUBLIC_ORIGIN` nennt die einbettende Webapp.
Alle drei Origins müssen verschieden sein. Die Startbereitschaft der Editoren
blockiert die Kernanwendung nicht.

## Office-Dokumente und Sitzungsstände

Der Dienst `office` stellt die Browsereditoren und den Abgleich verschlüsselter
Sitzungen bereit. Dokumente werden im Browser entschlüsselt und konvertiert.
Quell-Downloads und Klartext-Speichercallbacks an einen Dokumentserver sind in
diesem Ablauf ausgeschlossen. Der
[Editorleitfaden](editoren-ohne-klartextserver.md) beschreibt geprüfte
Funktionen und noch offene Fälle.

Das Volume `private-office-data` enthält verschlüsselte Bearbeitungsstände und
gehört zur Sicherung. Gemeinsame Projektdateien behalten ihre Räume nach einem
Dienstneustart. Eine ungespeicherte Excel-Exportansicht verwendet dagegen einen
temporären Raum und wird erst beim Herunterladen als lokale Datei übernommen.

Die Ablösung entfernt den bisherigen Dokumentserver aus Compose und
Entwicklungsskript. Vorhandene Klartextkopien in dessen `euro-office-*`-Volumes
und in Betreiberbackups werden durch den neuen Dienst nicht nachträglich
verschlüsselt. Ihre Aufbewahrung wird durch die neue Installation nicht
verändert.

## Laufzeitanforderungen

Die Webapp verwendet ein schreibgeschütztes Wurzeldateisystem. Generierte
Nginx-Konfiguration und gepufferte Anfragen liegen unter `/tmp`.
`WEBAPP_TMPFS_SIZE` (Standard `256m`) muss zu `CLIENT_MAX_BODY_SIZE` und
gleichzeitig laufenden Uploads passen. `net.ipv4.ip_unprivileged_port_start=0`
erlaubt Nginx innerhalb seines Netzwerk-Namensraums Port 80 ohne Root-Rechte.
Andere Umgebungen benötigen diese Einstellung oder angepasste Listener- und
Proxy-Ports.

Die API-Instanzen greifen auf denselben DuckDB-Datendienst zu. Nur dieser öffnet
die Mandantendateien. Für mehrere API-Instanzen hinter einem Load Balancer gilt
[Skalierung und Zusammenarbeit](../sortsys-api-v2/README.md#skalierung-und-zusammenarbeit).

## Sicherungen und Wiederanlauf

Für einen älteren Fachstand eines einzelnen Mandanten stehen
[registrierte Mandantensicherungen](verschluesselte-sicherungen.md) zur
Auswahl. Die dortige Rücksicherung setzt auf dem laufenden Datendienst auf und
behält dessen aktuelle Sicherheitsnachweise.

Für den Ausfall des gesamten Datendienstes braucht es einen zusammengehörigen
Dateisatz. Vor einer Kopie auf Dateiebene alle API-Instanzen und den
Office-Dienst anhalten. Danach den Datendienst regulär beenden und das Volume
`duckdb-data` vollständig sichern. Darin liegen `control.duckdb`, die
Mandantendateien unter `tenants/` und die registrierten Dateikopien unter
`snapshots/`. Vorhandene Begleitdateien zusammen mit ihrem jeweiligen
Datenbankstand sichern. Das Volume `private-office-data` enthält zusätzlich
die verschlüsselten Bearbeitungssitzungen.

Beim Wiederanlauf die zusammengehörigen Volumes im gestoppten Stack
bereitstellen und Dateinamen sowie Zugriffsrechte beibehalten. Zuerst DuckDB
starten, danach die API-Instanzen und den Office-Dienst. Mit einem
Mandantenkonto Anmeldung, Projektzugriff und einen Anhang prüfen. Die
Recovery-Phrase verbleibt beim Mandanten.

Eine alte Mandantendatei mit einer neueren Kontrolldatei wird gesperrt, sobald
Sicherheitsnachweise auseinanderlaufen. Wenn ein kompletter Dateisatz auf
einen früheren Stand zurückfällt, braucht es einen unabhängig aufbewahrten
aktuellen Nachweis, um den Rückstand erkennen zu können. Der
[Recovery-Leitfaden](mandanten-wiederherstellung.md#grenzen-der-ungültigkeit-und-wiederherstellung-alter-sicherungen)
beschreibt diese Grenze.

## Veröffentlichungen und Rückkehr zu älteren Ständen

Der [Veröffentlichungsablauf](../.github/BRANCHES.md) beschreibt die
Image-Builds. Für den neuen Compose-Betrieb werden API, Datendienst, Webapp und
Office benötigt. `ghcr-compose.yaml` verwendet standardmäßig `latest`. Für
reproduzierbare Installationen `SORTSYS_API_IMAGE`, `SORTSYS_STORE_IMAGE`,
`SORTSYS_WEBAPP_IMAGE` und `SORTSYS_OFFICE_IMAGE` auf einen geprüften Stand
festlegen, bevorzugt per Digest.

Persistente Daten vor Aktualisierungen sichern. Volumes beim Image-Wechsel
behalten; `compose down --volumes` löscht Daten. Ein älteres Image muss das
Dateiformat des gesicherten Bestands verstehen. Für einen älteren Fachstand
gelten dieselben Anforderungen an die aktuellen Recovery-Nachweise wie beim
Wiederanlauf.
