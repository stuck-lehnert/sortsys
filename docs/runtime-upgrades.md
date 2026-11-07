# Abgestimmte Laufzeitaktualisierungen

## Gemeinsame Versionsgrundlage

- `.node-version` legt Node 24 LTS fest. CI, Image-Katalog, Webapp-Build und Node-Typdeklarationen verwenden dieselbe Hauptversion. Andere Hauptversionen werden als gemeinsame Umstellung bewertet. Automatische Hauptversionsvorschläge für Node-Images und Deklarationen werden ignoriert; passende Node-24-Aktualisierungen bleiben möglich.
- Rust 1.99 gilt gemeinsam für CI, API-Build, Testimage-Vorgabe, Image-Katalog und DWG-/WASM-Build der Webapp. Teilweise Umstellungen erzeugen einen ungeprüften Compiler-Mix.
- Nginx verwendet die stabile 1.30-Reihe; der konkrete Tag steht im Webapp-Dockerfile. Dependabot ignoriert die 1.31-Mainline mit `~> 1.31.0`. Stabile Korrekturen und die nächste stabile Reihe bleiben zulässig.
- PostgreSQL bleibt auf Hauptversion 17. Hauptversionsvorschläge für Docker und Compose werden bis zu einer vorbereiteten Datenmigration ignoriert; kleinere Aktualisierungen bleiben möglich. Die vorhandenen Daten-Mounts bleiben bestehen.

`node scripts/check-runtime-versions.mjs` und seine Tests stehen am Anfang von
`scripts/ci`. Sie erkennen Abweichungen zwischen Images, CI und Typdeklarationen,
reine Tag-Wechsel bei PostgreSQL und ungeprüfte Nginx-Mainline-Umstellungen.
Betriebliche Vorgaben wie `POSTGRES_IMAGE` müssen gesondert geprüft werden;
Repository-Standards belegen keine eingesetzte Überschreibung.

## Nginx prüfen

`scripts/test-nginx.py` benötigt ein ausdrückliches `--nginx-command` und optional
`--mime-types`. Es vergleicht Version und Dockerfile, prüft die gerenderte Vorlage
mit `nginx -t` sowie SPA-Routen, fehlende Ressourcen, Cache-Header,
Office-/draw.io-Weiterleitungen, Proxy-Pfade, TLS-Weitergabe und WebSocket-Upgrade-Header.

Die Prüfung verwendet temporäre Dateien und eigene lokale Listener. Nginx erbt
einen reservierten Socket, damit keine fremde Portbelegung dazwischenkommt.
Kindprozesse und Threads werden abschließend beendet. Geprüft werden weder ein
vollständiger WebSocket-Relay noch laufende Office-/draw.io-Dienste oder PWA-/Offlineverhalten.

Genau die vorgesehene Nginx-Datei samt gegebenenfalls nötigem Loader angeben.
Ihre Korrekturversion muss zum Dockerfile passen. Die Prüfung verwendet weder
Container-Socket noch einen Ausweichzugriff auf den Host.

## PostgreSQL 17 → 18: Migration

PostgreSQL 18 nicht auf das bestehende PostgreSQL-17-Volume starten. Ein neuer
Image-Tag aktualisiert keinen Datenbankcluster. `compose down --volumes` ist kein
Migrationsschritt.

Vor Freigabe von Hauptversionsupdates und Änderung der Laufzeitprüfung:

1. **Bestand erfassen.** Image und Digest, `PGDATA`, Mounts, Master- und alle Mandantendatenbanken, Rollen, Erweiterungen, Größen, Gebietsschemata, Sortierungen und verwaltete Kubernetes-Instanzen festhalten. Schreibende Clients und geplante Aufträge erfassen.
2. **Sichern und Wiederherstellung testen.** Alle benötigten Datenbanken sowie globale Clusterobjekte und Rollen mit zu PostgreSQL 17 passenden Werkzeugen sichern. Ein Masterdatenbank-Dump deckt keine Mandantendatenbanken ab. Globale Daten können Passworthashes enthalten und müssen geschützt und verschlüsselt werden. Zusammenhängende Schreibzugriffe nötigenfalls pausieren und passenden Objektspeicher sowie Konfiguration sichern.
3. **Separate PostgreSQL-18-Instanz vorbereiten.** Für dieses Projekt einen erprobten logischen Export und Import bevorzugen; `pg_upgrade` nur mit eigens geprüftem Verfahren. Das alte Volume nicht überschreiben. Das offizielle 18-Image verwendet standardmäßig `/var/lib/postgresql/18/docker` als `PGDATA`; den übergeordneten Pfad `/var/lib/postgresql` einbinden und Compose-Varianten sowie Kubernetes-Erzeugung gemeinsam anpassen.
4. **Build- und Testclients gemeinsam aktualisieren.** Die API-Dockerfiles kopieren Werkzeuge aus `/usr/lib/postgresql/17/bin` und eine bestimmte libpq-Datei. PostgreSQL-18-Werkzeuge, Bibliotheken und Laufzeitabhängigkeiten tatsächlich prüfen. API-Sicherung und Wiederherstellung mit den neuen Werkzeugen testen.
5. **Testumgebung wiederherstellen und prüfen.** Globale Objekte und sämtliche Datenbanken ohne tolerierte Fehler wiederherstellen. Erweiterungen, Eigentümer, Rechte, Sequenzen, Mandantenrouting, Migrationen, Sortierung, Indizes und repräsentative Daten prüfen. Die vollständige dienstgestützte API-Suite, Sicherungsabläufe und Anwendungsfälle gegen die neue Datenbank ausführen.
6. **Umstellung und Rückkehr erproben.** API und Hintergrund-Schreibzugriffe stoppen, endgültig sichern, wiederherstellen beziehungsweise migrieren, prüfen und erst dann umschalten. Alten Cluster und verschlüsselte Sicherungen über den vereinbarten Rückkehrzeitraum aufbewahren. Nach Schreibzugriffen auf PostgreSQL 18 reicht ein alter Image-Tag nicht mehr: Die Behandlung der neuen Daten vorher festlegen.
7. **Erst danach Vorgaben ändern.** Laufzeit-, Test- und Clientstandards, Mounts, Kubernetes-Erzeugung, Prüfungen und Dokumentation gemeinsam umstellen. Die Hauptversionssperre erst mit einem freigegebenen Migrationsverfahren entfernen.

Diese Dokumentation führt selbst keine Bereitstellung oder Datenänderung aus.

## Grenzen automatischer Aktualisierungen

Neue Veröffentlichungen können direkt nach einem Push weitere Dependabot-PRs
auslösen. Ein erledigter Rückstand deaktiviert keine späteren Vorschläge.
npm- und Bun-Vorschläge überschneiden sich, weil beide Lockdateien verwendet und
geprüft werden; vor dem Schließen doppelter Vorschläge beide aktualisieren.

TypeScript-Hauptversionswechsel werden manuell koordiniert. Client- und
Webapp-Lintskripte verwenden die JavaScript-Compiler-API. Der versuchte
TypeScript-7-Wechsel scheiterte an `ts.ScriptTarget.Latest`; beide behalten daher
die funktionierende 5.9-API. Der DWG-Viewer nutzt TypeScript 7 bereits für reine
CLI-Prüfungen. Kompatible Wartungsupdates bleiben möglich.

PDF.js-Aktualisierungen müssen beide exakten Paketversionen, beide Lockdateien
und das per Prüfsumme verifizierte offizielle Viewer-/Worker-ZIP gemeinsam
aktualisieren. Dependabot bündelt Bibliotheksvorschläge; das ZIP bleibt ein eigens
zu prüfender Bestandteil. Das Vite-Plugin weist unterschiedliche Versionen oder
ungebundene Viewer-Paketbereiche zurück. Nur das DWG-Paket zu ändern genügt nicht.
