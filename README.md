# sortsys

sortsys ist eine Branchensoftware für Bauunternehmen und Handwerksbetriebe auf
Auftragnehmerseite. Sie verbindet Angebotskalkulation, Projektabwicklung und
Abrechnung: Aus angenommenen Angeboten entstehen Projekte, in denen Aufmaße,
Nachträge, Weitervergaben und Rechnungen auf denselben Leistungen aufbauen.

Dazu kommen Einsatzplanung, Bautagesberichte, Materiallieferungen und die
Verwaltung von Werkzeugen, Plänen und weiteren Dokumenten. GAEB-Dateien lassen
sich gemeinsam direkt im Browser bearbeiten. Die Oberfläche ist auf Deutsch und
Englisch verfügbar.

## Entwicklung

Voraussetzungen: Bash und Docker oder Podman. Im Hauptverzeichnis starten:

```bash
./scripts/dev
```

Die Webapp ist unter <http://127.0.0.1:5173> erreichbar. Im vorbereiteten
Mandanten `test` hat `john.doe@test` Administratorrechte; `frank.doe@test` hat
keine besonderen Berechtigungen. Beide Konten und die lokale Betreiberverwaltung
verwenden das Passwort `123456`. Weitere Mandanten werden über einen einmaligen
Link eingerichtet.

Entwicklungsdaten bleiben unter `.dev-data/zerotrust/` erhalten. `Ctrl+C`
beendet die Umgebung. Konfiguration und Protokolle beschreibt der
[Entwicklungsleitfaden](docs/development.md). Die
[Bestandsübernahme](docs/bestandsumstellung.md) beschreibt die Einrichtung mit
einer Sicherung aus der früheren Installation.

## Prüfungen

```bash
./scripts/ci        # Gesamtes Repository prüfen
./scripts/test-api  # API-Integration und Client prüfen
```

Der [CI- und Veröffentlichungsablauf](.github/BRANCHES.md) erklärt Branch-Tests
und die Übernahme von `predeploy` nach `deploy`.

## Pakete

| Paket                                             | Aufgabe                                                                      |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| [API](sortsys-api-v2/README.md)                   | Rust-Dienst, Mandantendatenbanken und typisierter TypeScript-Client          |
| [Datendienst](sortsys-store/README.md)            | DuckDB-Mandantendateien, atomare Metadaten und Sicherungen                   |
| [Webapp](sortsys-webapp-v2/README.md)             | React-Anwendung für Angebote, Projekte und Verwaltung                        |
| [Komponenten](sortsys-react-components/README.md) | Einheitliche Bedienelemente und Gestaltung                                   |
| [GAEB](sortsys-gaeb/README.md)                    | Dokumente direkt bearbeiten und Leistungen kalkulieren                       |
| [Planansicht](sortsys-dwgviewer/README.md)        | PDF-/DWG-Pläne mit Rust-/WASM-Parser                                         |
| [Kryptografie](sortsys-zerotrust/README.md)       | Wiederverwendbare Bausteine für verschlüsselte Daten, Freigaben und Recovery |

Verarbeitung erfolgt nach Möglichkeit im Browser. Die API übernimmt Speicherung,
Berechtigungen und Vorgänge, die einen verbindlichen gemeinsamen Datenstand
benötigen. Alte Bestände werden
[beim Anlegen eines Mandanten aus einer Sicherung übernommen](docs/bestandsumstellung.md).
Das [Verschlüsselungsmodell](docs/verschluesselung-und-berechtigungen.md)
beschreibt Freigaben, Recovery und die Grenzen der Absicherung vertraulicher
Inhalte.

## Bereitstellung

Der [Betriebsleitfaden](docs/deployment.md) führt durch Compose, Coolify und die
veröffentlichten Container-Images. Ausgangspunkt ist
[.compose-env.example](.compose-env.example).

## Lizenz und Gemeinschaft

sortsys steht unter der [AGPL-3.0-only](LICENSE). Für Beiträge und den Austausch
im Projekt gilt der [Verhaltenskodex](CODE_OF_CONDUCT.md).

Für fremde Abhängigkeiten und Beispieldateien gelten deren eigene Lizenzen und
Hinweise.
