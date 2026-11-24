# Quelle der Master-Musterdaten

Der Referenzbestand stammt aus dem Entwicklungsseed von `master` am Commit
`513058b46c1659f6227e32b0284f90613011be17`. Der Lauf verwendet den
Zufallsstartwert `42` und den UTC-Stichtag `2026-11-20`. PostgreSQL vergibt
einige IDs und Zeitstempel bei jedem neuen Lauf. Für den Vergleich dient daher
die gespeicherte Referenz als gemeinsame Quelle.

Die Datei `sortsys-webapp-v2/scripts/development/master-seed-reference.json.gz`
enthält 4.801 COPY-Datensätze aus 40 Tabellen und 304 Dateiobjekte. Sie enthält
keine Kontopasswörter, Sitzungen, Passkeys oder Rollenzuordnungen. Der
Offline-Test prüft den Bestand und alle SHA-256-Prüfsummen:

```sh
python3 -B scripts/seed-export-master.test.py -v
```

Für einen neuen Export werden Rust, Python 3 und die PostgreSQL-Werkzeuge
einschließlich `pgcrypto` benötigt. Der Exporter erstellt einen temporären
Worktree und einen separaten PostgreSQL-Cluster auf Loopback. Der aktuelle
Checkout und bestehende Datenbankserver bleiben unverändert. Die Ausgabe
muss auf einen neuen Pfad zeigen:

```sh
python3 scripts/seed-export-master.py /tmp/master-reference.json.gz
```

Das Exportieren und Prüfen der Referenz ändert den Standardbestand von
`scripts/dev` nicht und belegt noch keine verschlüsselte Übernahme.
