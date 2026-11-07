# CI und Veröffentlichungsablauf

- Branch-Pushes prüfen das Repository mit `scripts/ci`. Auf `predeploy` entfällt
  ein erneuter Testlauf, wenn exakt derselbe Commit bereits erfolgreich geprüft wurde.
- Ein erfolgreicher `predeploy`-Lauf übernimmt den geprüften Commit per Fast-forward
  nach `deploy`. Überholte Commits können nicht mehr veröffentlicht werden.
- Auf `deploy` werden API, Hintergrunddienst und Webapp mit ihren regulären
  Dockerfiles gebaut und in GHCR veröffentlicht. Die Tags sind `latest` und die
  ersten zehn Zeichen der Commit-SHA.

Die CI reagiert auf Branch-Pushes. Das Öffnen oder Aktualisieren eines Pull Requests
startet keinen doppelten Lauf für denselben Commit. Tags starten keine CI.
Ein direkter Push auf `deploy` startet Tests und Container-Veröffentlichung;
der reguläre Weg führt zuerst über die Tests auf `predeploy`.

Dieselben Prüfungen lokal ausführen:

```bash
./scripts/ci
```

## GitHub einrichten

`master` bleibt der Standardbranch. Die Veröffentlichungsbranches einmalig anlegen:

```bash
git push origin master:predeploy
git push origin master:deploy
```

Die Workflows fordern die benötigten `GITHUB_TOKEN`-Rechte an: Leserechte für Tests
und CI-Verlauf, Schreibrechte auf Inhalte und Actions für die Übernahme sowie
Paket-Schreibrechte für die Veröffentlichung. Repository- und Organisationsregeln
müssen diese Rechte erlauben. Zusätzliche PATs, GitHub Apps oder Geheimnisse sind
nicht erforderlich.

Die Übernahme verwendet einen normalen Fast-forward-Push. Ein Push mit
`GITHUB_TOKEN` startet keinen weiteren Push-Workflow. Deshalb startet derselbe
Job anschließend `publish-containers.yml` auf `deploy` ausdrücklich per
`workflow_dispatch`. [GitHub beschreibt das Token-Verhalten und die Dispatch-Ausnahme](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow).
Vor der ersten Nutzung die Workflows in den Standardbranch übernehmen.

## Einen Stand veröffentlichen

```bash
git push origin master:predeploy
```

Ein abgeschlossener, erfolgreicher `ci.yml`-Push-Lauf aus diesem Repository zählt
für exakt dieselbe Commit-SHA unabhängig vom ursprünglichen Branch. Dann werden
Compiler-Einrichtung und Tests übersprungen und die Übernahme beginnt direkt.
Fehlgeschlagene, abgebrochene, laufende, fremde oder zu anderen Commits gehörende
Läufe zählen nicht. Ohne Treffer oder bei fehlgeschlagener Abfrage laufen die
Tests regulär. Die Grundlage ist der CI-Verlauf.

Vor der Übernahme müssen die Tests dieses Commits erfolgreich abgeschlossen sein.
Ändert sich `predeploy` währenddessen, darf der ältere Lauf den neuen Stand nicht
übernehmen. Git weist eine abweichende `deploy`-Historie zurück; diese muss vorher
integriert werden. Für eine Rücknahme einen Revert-Commit verwenden.

Scheitert die Container-Veröffentlichung nach der Übernahme, lässt sich
`Publish containers` auf `deploy` manuell erneut starten. Auf anderen Branches
veröffentlicht dieser Workflow nichts. Veröffentlichungen laufen nacheinander;
ein laufender Vorgang wird nicht unterbrochen.

Die CI überträgt keine kompilierten Artefakte zwischen Jobs und pflegt keine
eigenen entfernten Build-Caches. Reguläre Docker-Caches innerhalb eines Builds
bleiben verfügbar. Prüfungen von Updates bestehender Installationen und
Container-Laufzeitprüfungen sind optionale lokale Werkzeuge.
