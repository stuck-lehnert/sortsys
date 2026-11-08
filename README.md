# sortsys

sortsys ist eine Branchensoftware für Bauunternehmen und Handwerksbetriebe auf
Auftragnehmerseite. Sie verbindet Angebotskalkulation, Projektabwicklung und
Abrechnung: Aus angenommenen Angeboten entstehen Projekte, in denen Aufmaße,
Nachträge, Weitervergaben und Rechnungen auf denselben Leistungen aufbauen.

Dazu kommen Einsatzplanung, Bautagesberichte, Materiallieferungen und die
Verwaltung von Werkzeugen, Plänen und weiteren Dokumenten. GAEB-Dateien lassen sich
gemeinsam direkt im Browser bearbeiten. Die Oberfläche ist auf Deutsch und Englisch verfügbar.

## Entwicklung

Voraussetzungen: Bash und Docker oder Podman. Im Hauptverzeichnis starten:

```bash
./scripts/dev
```

Die Webapp ist unter <http://127.0.0.1:5173> erreichbar. Lokaler Administrator:
Mandant `test`, Benutzer `john.doe`, Passwort `123456`.

**Jeder Start legt die Entwicklungsdatenbanken neu an und befüllt sie mit Beispieldaten.**
`Ctrl+C` beendet die Umgebung. Konfiguration und Protokolle beschreibt der
[Entwicklungsleitfaden](docs/development.md).

## Prüfungen

```bash
./scripts/ci        # Gesamtes Repository prüfen
./scripts/test-api  # API-Integration und Client prüfen
```

Der [CI- und Veröffentlichungsablauf](.github/BRANCHES.md) erklärt Branch-Tests
und die Übernahme von `predeploy` nach `deploy`.

## Pakete

| Paket | Aufgabe |
| --- | --- |
| [API](sortsys-api-v2/README.md) | Rust-Dienst, Mandantendatenbanken und typisierter TypeScript-Client |
| [Webapp](sortsys-webapp-v2/README.md) | React-Anwendung für Angebote, Projekte und Verwaltung |
| [Komponenten](sortsys-react-components/README.md) | Einheitliche Bedienelemente und Gestaltung |
| [GAEB](sortsys-gaeb/README.md) | Dokumente direkt bearbeiten und Leistungen kalkulieren |
| [Planansicht](sortsys-dwgviewer/README.md) | PDF-/DWG-Pläne mit Rust-/WASM-Parser |
| [Hintergrunddienst](sortsys-v2-job_runner/README.md) | Medienverarbeitung und Texterkennung |

Verarbeitung erfolgt nach Möglichkeit im Browser. Die API übernimmt Speicherung,
Berechtigungen und Vorgänge, die einen verbindlichen gemeinsamen Datenstand benötigen.

## Bereitstellung

Der [Betriebsleitfaden](docs/deployment.md) führt durch Compose, Coolify und die
veröffentlichten Container-Images. Ausgangspunkt ist [.compose-env.example](.compose-env.example).

## Lizenz und Gemeinschaft

sortsys steht unter der [AGPL-3.0-only](LICENSE). Für Beiträge und den Austausch im
Projekt gilt der [Verhaltenskodex](CODE_OF_CONDUCT.md).

Für fremde Abhängigkeiten und Beispieldateien gelten deren eigene Lizenzen und Hinweise.
