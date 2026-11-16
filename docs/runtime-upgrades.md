# Abgestimmte Laufzeitaktualisierungen

## Gemeinsame Versionsgrundlage

- `.node-version` legt Node 24 LTS fest. CI, Image-Katalog, Webapp-Build und
  Node-Typdeklarationen verwenden dieselbe Hauptversion. Andere Hauptversionen
  werden als gemeinsame Umstellung bewertet. Automatische
  Hauptversionsvorschläge für Node-Images und Deklarationen werden ignoriert;
  passende Node-24-Aktualisierungen bleiben möglich.
- Rust 1.99 gilt gemeinsam für CI, API-Build, Testimage-Vorgabe, Image-Katalog
  und DWG-/WASM-Build der Webapp. Teilweise Umstellungen erzeugen einen
  ungeprüften Compiler-Mix.
- Nginx verwendet die stabile 1.30-Reihe; der konkrete Tag steht im
  Webapp-Dockerfile. Dependabot ignoriert die 1.31-Mainline mit `~> 1.31.0`.
  Stabile Korrekturen und die nächste stabile Reihe bleiben zulässig.
- DuckDB wird zusammen mit der nativen Bibliothek und den Erweiterungen
  festgelegt. Der Installer unter `sortsys-api-v2/rust-api/duckdb/` prüft die
  heruntergeladenen Dateien. Nur der gemeinsame Datendienst öffnet die
  Mandantendateien.

`node scripts/check-runtime-versions.mjs` und seine Tests stehen am Anfang von
`scripts/ci`. Sie erkennen Abweichungen zwischen Images, CI und Typdeklarationen
sowie ungeprüfte Nginx-Mainline-Umstellungen.

## Nginx prüfen

`scripts/test-nginx.py` benötigt ein ausdrückliches `--nginx-command` und
optional `--mime-types`. Es vergleicht Version und Dockerfile, prüft die
gerenderte Vorlage mit `nginx -t` sowie SPA-Routen, fehlende Ressourcen,
Cache-Header, Office-/draw.io-Weiterleitungen, Proxy-Pfade, TLS-Weitergabe und
WebSocket-Upgrade-Header.

Die Prüfung verwendet temporäre Dateien und eigene lokale Listener. Nginx erbt
einen reservierten Socket, damit keine fremde Portbelegung dazwischenkommt.
Kindprozesse und Threads werden abschließend beendet. Geprüft werden weder ein
vollständiger WebSocket-Relay noch laufende Office-/draw.io-Dienste oder
PWA-/Offlineverhalten.

Genau die vorgesehene Nginx-Datei samt gegebenenfalls nötigem Loader angeben.
Ihre Korrekturversion muss zum Dockerfile passen. Die Prüfung verwendet weder
Container-Socket noch einen Ausweichzugriff auf den Host.

## Datenhaltung aktualisieren

Der neue Aufbau wird unabhängig von der früheren PostgreSQL-Installation
betrieben. Er aktualisiert deren Datenbanken nicht. Alte Sicherungen werden beim
Anlegen eines neuen Mandanten im Browser gelesen und vor der Übertragung
verschlüsselt. Unterstützte Archive und Einschränkungen beschreibt die
[Bestandsübernahme](bestandsumstellung.md).

Vor einem DuckDB-Versionswechsel eine konsistente Sicherung über den Datendienst
erstellen und deren Wiederherstellung mit der neuen Version prüfen. Eine
Mandantendatei während laufender Schreibzugriffe mit `cp` zu kopieren liefert
keine verlässliche Sicherung. Die Diensttests prüfen parallele API-Zugriffe,
atomare Änderungen und das Wiederöffnen gesicherter Dateien.

Der Stand der Umsetzung, die unabhängigen Versionsnachweise und die Grenzen beim
Rückspielen alter Bestände stehen unter
[Bestandsübernahme](bestandsumstellung.md) und
[Mandantenwiederherstellung](mandanten-wiederherstellung.md).

## Grenzen automatischer Aktualisierungen

Neue Veröffentlichungen können direkt nach einem Push weitere Dependabot-PRs
auslösen. Ein erledigter Rückstand deaktiviert keine späteren Vorschläge. npm-
und Bun-Vorschläge überschneiden sich, weil beide Lockdateien verwendet und
geprüft werden; vor dem Schließen doppelter Vorschläge beide aktualisieren.

TypeScript-Hauptversionswechsel werden manuell koordiniert. Client- und
Webapp-Lintskripte verwenden die JavaScript-Compiler-API. Der versuchte
TypeScript-7-Wechsel scheiterte an `ts.ScriptTarget.Latest`; beide behalten
daher die funktionierende 5.9-API. Der DWG-Viewer nutzt TypeScript 7 bereits für
reine CLI-Prüfungen. Kompatible Wartungsupdates bleiben möglich.

PDF.js-Aktualisierungen müssen beide exakten Paketversionen, beide Lockdateien
und das per Prüfsumme verifizierte offizielle Viewer-/Worker-ZIP gemeinsam
aktualisieren. Dependabot bündelt Bibliotheksvorschläge; das ZIP bleibt ein
eigens zu prüfender Bestandteil. Das Vite-Plugin weist unterschiedliche
Versionen oder ungebundene Viewer-Paketbereiche zurück. Nur das DWG-Paket zu
ändern genügt nicht.
