# Gemeinkostensätze verwalten

Die Aktion **Gemeinkosten** öffnet die Sätze für interne Arbeitszeit, Material
und Nachunternehmer. Ein Stichtag bestimmt, ab wann die neuen Werte gelten. Beim
Speichern werden alle drei Sätze gemeinsam übernommen. Scheitert eine Änderung,
bleiben auch die beiden anderen Sätze unverändert.

Die Historie bleibt erhalten. Bei einer späteren Kostenberechnung gilt der
letzte Satz, dessen Stichtag nicht nach dem Belegdatum liegt. Ein Satz mit einem
künftigen Stichtag wird daher noch nicht angewendet. Die
[Projektkostenauswertung](verschluesselte-projektkosten.md) liest diese Historie
im Browser.

## Zugriff freigeben

In der Benutzerverwaltung enthält die Freigabe eines registrierten Mitarbeiters
einen eigenen Abschnitt **Gemeinkostenfreigabe**. Dort lassen sich Lesen,
Anlegen, Bearbeiten und Löschen getrennt vergeben. Ein Mitarbeiter kann die
Gemeinkostensätze auch ohne Zugriff auf einzelne Projekte lesen. Umgekehrt geben
Projektberechtigungen keine Gemeinkostensätze frei.

Der Bereich `organization:calculation` hat einen eigenen Schlüssel. Neue
Mitarbeiter erhalten ihn erst mit einer ausdrücklichen Freigabe. Auch ein
Administrator benötigt eine gültige Inhaltsfreigabe. Eine verweigerte oder
fehlgeschlagene Abfrage wird als Fehler angezeigt; sie liefert keine
vermeintliche Historie mit Nullwerten. Reiner Lesezugriff öffnet das Formular
ohne Bearbeitungs- und Speichermöglichkeit.

## Speicherung und Bestandsübernahme

Jeder Satz liegt als eigenes verschlüsseltes Objekt vor. Dadurch können Anlegen,
Ändern und Löschen jeweils die passende signierte Berechtigung verwenden. Typ
und Stichtag bilden gemeinsam einen eindeutigen fachlichen Schlüssel. Die lokale
DuckDB prüft diese Eindeutigkeit vor der Veröffentlichung. Unterschiedliche
Browser oder API-Instanzen gleichen Änderungen über die gemeinsame
Versionsprüfung ab. Nach einem Konflikt liest der Client den aktuellen Stand
erneut, bevor er seine Änderung wiederholt.

Die Bestandsübernahme liest die Sätze aus dem geprüften, verschlüsselten Archiv.
Sie bewahrt Kennungen, ursprüngliche Benutzerbezüge und Zeitangaben. Eine
wiederholte Übernahme akzeptiert exakt gleiche Zieldaten und überschreibt keine
Abweichungen. Eine Seed-Recovery erhält die gespeicherte Historie.

Datumsangaben im Formular gelten ab 00:00 Uhr UTC. Bereits vorhandene
Zeitstempel behalten ihre Mikrosekunden, auch wenn mehrere Sätze innerhalb
derselben Millisekunde liegen. Die API erhält verschlüsselte Inhalte und die für
Berechtigungen und Versionsprüfung erforderlichen Metadaten. Sie kann die
fachliche Gültigkeit eines berechtigt signierten Inhalts nicht unabhängig vom
Client prüfen.

Die [Adaptertests](../sortsys-webapp-v2/app/lib/data/commonCosts.test.mjs)
prüfen unter anderem historische Stichtage, getrennte Einzelrechte, parallele
Änderungen und unterbrochene Speicherantworten. Der
[native Integrationstest](../sortsys-webapp-v2/scripts/test-live-common-costs.ts)
verwendet zwei unabhängige API-Prozesse; der gemeinsame Testlauf prüft außerdem
zwei aufeinanderfolgende Seed-Recoveries.
