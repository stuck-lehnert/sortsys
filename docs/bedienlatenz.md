# Bedienlatenz zwischen Master und Zero Trust vergleichen

Für die Messung müssen zwei lokale Installationen mit gebauten Webapps laufen: `master` und `draft/zerotrust`. Beide erhalten denselben fachlichen Beispieldatenbestand. Der Testbenutzer muss auf beiden Seiten dasselbe Projekt und Angebot sehen und den GAEB-Editor öffnen dürfen. Auf demselben Rechner messen, ohne gleichzeitig zu bauen oder Daten zu importieren.

Die Master-Referenz kann in einem neuen lokalen PostgreSQL-Cluster mit
temporärem Objektdienst geöffnet werden. Mit `SORTSYS_MASTER_SEED_BIN` auf das
`seed_dev`-Binary von `513058b` prüft `python3 scripts/seed-export-master.test.py`
diesen Aufbau. Der Test vergleicht die erneut exportierten Zeilen aller 40
Tabellen sowie die Bytes aller 304 Dateiobjekte und prüft beide Testkonten.
Er startet keine Webapp und misst noch keine Bedienlatenz.

1. `SORTSYS_LATENCY_MASTER_URL` und `SORTSYS_LATENCY_ZT_URL` auf die lokalen Webapp-URLs setzen. Die jeweiligen Testzugänge über `SORTSYS_LATENCY_MASTER_USER` / `SORTSYS_LATENCY_MASTER_PASSWORD` und `SORTSYS_LATENCY_ZT_USER` / `SORTSYS_LATENCY_ZT_PASSWORD` übergeben. Der Benutzername enthält den Mandanten, wie im Anmeldeformular. Keine Produktivzugänge verwenden.
2. Mit `SORTSYS_LATENCY_PROJECT` und `SORTSYS_LATENCY_OFFER` Titel angeben, die in beiden Installationen auf der ersten Seite der aktiven Projekt- bzw. Angebotsliste sichtbar sind. Das Angebot muss ein GAEB-Dokument haben. `SORTSYS_LATENCY_SEARCH` enthält einen Teil des Projekttitels, der in der Befehlspalette zum Projekt führt.
3. `node sortsys-webapp-v2/scripts/e2e/interaction-latency.mjs` ausführen. Optional kann `SORTSYS_E2E_CHROMIUM` auf ein vorhandenes Chromium zeigen. `SORTSYS_LATENCY_SAMPLES` bestimmt die Anzahl der Durchläufe pro Variante (Standard: zwölf).

Ohne zwei Webserver kann das Messskript beide gebauten SPAs selbst über den
gleichen lokalen Testproxy ausliefern. Dafür anstelle der beiden `*_URL`-Werte
jeweils `SORTSYS_LATENCY_{MASTER,ZT}_CLIENT_DIR` auf das gebaute Verzeichnis mit
`index.html` setzen und `SORTSYS_LATENCY_{MASTER,ZT}_API_URL` auf zwei getrennte
API-Endpunkte unter `http://127.0.0.1:<Port>/`. Beide APIs müssen aus demselben
Testlauf erreichbar sein. Das Skript beendet die Proxys nach der Messung;
APIs und Datenbestände verwaltet der aufrufende Testlauf. Die JSON-Ausgabe
kennzeichnet diese Variante als `shared-test-proxy`. Sie vergleicht beide
SPAs unter gleichen Auslieferungsbedingungen, nicht das Verhalten der
Produktionsproxies.

Der Proxy öffnet beide SPAs im Browser unter `localhost`, damit Master
seine API über den gleichen Ursprung anspricht. Bei manueller Einrichtung
von Master schaltet die Browseradresse `127.0.0.1` dagegen auf API-Port 3000.

## Messpunkte

Gemessen wird ab der Bedienaktion bis zur sichtbaren Antwort. Die Anmeldung
endet am sichtbaren Einstellungslink. Beim ersten Aufruf und bei der Rückkehr
zur Projektliste zählt die Projektzeile; im Detail zählt die Überschrift des
Projekts. Bei gesetztem `SORTSYS_LATENCY_PROJECT_CONTACTS` misst
`detailWithContacts` auch die Zeit vom Öffnen des Projekts bis zur
Ansprechpartner-Schaltfläche mit der erwarteten Anzahl. Für den
Master-Musterbestand beträgt diese Anzahl `1`. Die Suche wartet auf einen neu
erschienenen Projekttreffer mit genau diesem Titel. Bei der Angebotsliste
zählt die Angebotszeile in der fertig geladenen Liste.

Beim Öffnen des Angebots zählt die sichtbare GAEB-Dokumentfläche. In Zero
Trust muss auch der freigegebene Dokumentinhalt vollständig geladen sein.
Die Projektkennung aus der Detailadresse und die Angebotsnummer aus der
Liste müssen in allen Runden auf beiden Seiten übereinstimmen. Der Test gibt
beide Kennungen aus und bricht bei einer Abweichung ab. Das ersetzt nicht den
Abgleich des Musterbestands.

Die Gruppe **Projektarbeit** wird nach der Anmeldung außerhalb der Messung
aufgeklappt, falls sie geschlossen ist. Jede Runde nutzt einen frischen
Browserkontext; der Rückweg zur Projektliste nutzt denselben Kontext. Die
Server bleiben zwischen Runden aktiv. Das ist ein Test mit kaltem
Browserzustand, kein Test des Server-Kaltstarts. Das Zeitlimit pro
Browseraktion beträgt standardmäßig 30 Sekunden. `SORTSYS_LATENCY_ACTION_TIMEOUT_MS`
setzt ein anderes Limit in Millisekunden, ohne einen fehlgeschlagenen Lauf
als Messwert zu zählen.

Die Ausgabe enthält Einzelwerte und das 50. und 95. Perzentil in Millisekunden. `pairedDifference` fasst die Differenzen (Zero Trust minus Master) innerhalb derselben Messrunde zusammen. Ein positiver Wert bedeutet eine langsamere Antwort in Zero Trust. Fehlende Ansichten oder Treffer brechen die Messung ab, statt als schnelle Antworten zu zählen. Für verwertbare Ergebnisse neben der Ausgabe auch Commitstände, Seed-Stand, Hardware und Browser-Version festhalten. Messungen in einer CPU-emulierten VM zeigen nur das Verhalten in dieser Umgebung.

## RPC- und Kryptodiagnose

Ein separater Lauf mit `SORTSYS_LATENCY_DIAGNOSTICS=1` verwendet dieselben
Browseraktionen und sichtbaren Endpunkte. Pro Schritt zählt er HTTP-RPCs
zur jeweiligen Testinstallation. Eine durch Komma getrennte Prozedurenliste
steht für einen gemeinsamen HTTP-Aufruf. Die Diagnose zählt Aufrufe und
ihre bis zum Messpunkt beobachteten Abschlüsse sowie Transportfehler, ohne Parameter, Header oder Inhalte
auszugeben.

`elapsedMs` je HTTP-Route addiert die Dauer abgeschlossener Aufrufe.
`rpcTiming.coveredMs` zählt überlappende Zeiträume nur einmal;
`peakConcurrent` gibt die größte Anzahl gleichzeitig laufender Aufrufe an.
Beide Werte berücksichtigen nur Aufrufe mit Zeitmessung, die im selben Schritt
begonnen haben und bis zum Messpunkt ohne Transportfehler abgeschlossen wurden.
Sie zeigen, wann RPCs liefen, nicht, welche Antworten die Ansicht aufhielten.

Für WebCrypto zählt sie unter anderem Signaturprüfungen, Entschlüsselungen,
Schlüsselimporte und -ableitungen im Hauptfenster. Arbeit in Workern und
WebAssembly zählt nicht dazu. Bei WebCrypto können Aufrufe aus dem vorherigen
Schritt noch im aktuellen Schritt enden. `elapsedMs` summiert die Dauer der
erfassten Abschlüsse; parallele Aufrufe können sich dabei überlappen.
`detailWithContacts` schließt `detail` ein. Die Diagnose protokolliert keine
Schlüssel oder Klartexte und liefert keine Bedienlatenz-Perzentile. Die
Bedienlatenz wird ohne diese Instrumentierung gemessen.

Mit `SORTSYS_LATENCY_WAIT_DASHBOARD=1` wartet der Test nach dem sichtbaren
Einstellungslink zusätzlich auf das Dashboard ohne Ladeanzeigen für Verlauf
und Aktivitäten. `dashboardAfterLogin` erfasst diesen Abschnitt getrennt.
So lässt sich der erste Aufruf der Projektliste nach einem sichtbaren
Dashboard mit dem direkten Wechsel vergleichen. Die Wartebedingung betrifft
nur die sichtbaren Bereiche; Hintergrundarbeit kann weiterlaufen. Werte aus
den beiden Abläufen nicht als eine Stichprobe zusammenfassen.

Weniger Kryptografieaufrufe sind für sich genommen kein Nachweis für schnellere
Bedienung. Der verworfene Cache für Chiffrat-Signaturen sparte in einer
Chromium-Probe mit 32 synthetischen Datensätzen Signaturprüfungen (kalt
64 → 40, warm 64 → 16). Die Dauer des Ablaufs aus Autorensuche und Öffnen
sank dabei aber nicht: Erneutes Framing und Hashing kosten ebenfalls Zeit.
Die Probe lief in der CPU-emulierten VM und ersetzt keinen App-Vergleich.

## Erste Aktivität auf dem Dashboard

Die kalte Aktivitätsabfrage liest den verschlüsselten Verlauf parallel zum
aktuellen Berechtigungsstand. Sie öffnet die Einträge erst nach der Prüfung.
Innerhalb derselben Seite öffnet sie identische, signierte Objektpakete nur
einmal. Ein verändertes Paket oder ein entzogener Zugriff darf das frühere
Ergebnis nicht wiederverwenden.

Ein Chromium-157-Vergleich in der emulierten VM prüfte die Produktionsbuilds
von `355e663` und `de869ef` auf demselben kleinen Zero-Trust-Testmandanten.
Nur der Aktivitätslesepfad unterscheidet die beiden Versionen. Jedes der zehn
Paare verwendete frische Browserkontexte und wechselte die Reihenfolge.
Beide Versionen zeigten dieselben drei Aktivitätseinträge.

| Messpunkt bis zum sichtbaren Eintrag | p50 vorher → nachher | Median der gepaarten Differenzen | Schnellere Paare |
| --- | ---: | ---: | ---: |
| Ab Dashboard-Adresse | 3.923 → 3.414 ms | −299 ms | 9 von 10 |
| Ab Klick auf Anmelden | 9.387 → 8.791 ms | −363 ms | 8 von 10 |

Der erste Messpunkt beginnt, sobald der Test die Dashboard-Adresse erkennt,
nicht zwingend beim ersten Request der Ansicht. Die Messung zeigt die Wirkung
beider Änderungen zusammen, keinen Geschwindigkeitsvergleich mit Master.
In zwei getrennten Diagnosepaaren blieben die WebCrypto-Zähler im Hauptfenster
gleich (je 53 Signaturprüfungen und 17 Entschlüsselungen). Die Beschleunigung
belegt daher für dieses kleine Beispiel nicht weniger Kryptografie.

Für eine Wiederholung in `sortsys-webapp-v2` die beiden `build/client`-Ordner
an `node scripts/e2e/activityLatency.browser.mjs` übergeben. Der Test erwartet
eine isolierte API und ein Testkonto (`SORTSYS_DISPOSABLE_AUTH_TEST=1`,
`SORTSYS_AUTH_E2E_API`, `SORTSYS_AUTH_E2E_USERNAME`, `SORTSYS_AUTH_E2E_PASSWORD`).
`SORTSYS_LATENCY_PROJECT` bezeichnet den erwarteten Aktivitätstitel. Für die
Messung `SORTSYS_LATENCY_SAMPLES` setzen; mit `SORTSYS_LATENCY_DIAGNOSTICS=1`
in einem getrennten Lauf nur RPC- und WebCrypto-Zähler ermitteln.
