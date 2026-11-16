# Projektkosten aus freigegebenen Daten

Unter **Projekt → Kosten** werden Auftrags- und Rechnungssummen mit Material,
Arbeitszeit, Nachunternehmerstunden, Werkzeugnutzung und Gemeinkosten
verglichen. Die Berechnung läuft im Browser. Die API speichert die
verschlüsselten Belege und verteilt Änderungen an verbundene Clients.

Die projektübergreifende Übersicht verwendet dieselbe Berechnung wie die
Einzelansicht. Damit zählen auch externe Arbeitsstunden in beiden Ansichten
gleich. Die bisherige PostgreSQL-Übersicht hatte diese Stunden ausgelassen,
während der Detailbericht sie bereits berücksichtigte.

## Die benötigten Freigaben

Die Auswertung verbindet mehrere getrennt geschützte Datenbereiche:

| Daten                                               | Freigabe                                                |
| --------------------------------------------------- | ------------------------------------------------------- |
| Projektbezeichnung und Baustellenadresse            | Projektgrunddaten                                       |
| Angenommene Aufträge und manuelle Angebotssummen    | Auftragswerte des Projekts                              |
| Zugeordnete Rechnungen und manuelle Rechnungssummen | Rechnungswerte des Projekts                             |
| Materialmengen und Sonderposten                     | Lieferscheine und Lieferscheinpreise des Projekts       |
| Arbeitsstunden und erfasste Stundensätze            | Bautagesberichte und interne Arbeitskosten des Projekts |
| Ausgaben, Rückgaben und historische Werkzeugkosten  | Werkzeugnutzung und Werkzeugkosten des Projekts         |
| Historische Einkaufspreise                          | Produktpreise des gemeinsamen Katalogs                  |
| Zuschläge und Konstanten                            | Gemeinkostensätze der Organisation                      |

Die Freigaben des Projekts werden in der Benutzerverwaltung im Abschnitt
**Projektzugriff** vergeben. Die Produktpreise haben eine gemeinsame
Katalogfreigabe; deren Lesezugriff umfasst derzeit die gesamte Preishistorie des
Katalogs. Die [Gemeinkostenfreigabe](verschluesselte-gemeinkosten.md) wird
separat erteilt. Eine Administrationsrolle ersetzt keine dieser
Inhaltsfreigaben.

Fehlt eine benötigte Freigabe, zeigt die Übersicht für das betroffene Projekt
keine Beträge und nennt den fehlenden Zugriff. Der Detailbericht erklärt den
Fehler und bietet einen erneuten Versuch an. Auch PDF- und Excel-Tabellenexporte
der Übersicht behalten leere Beträge bei und enthalten den Hinweis. Eine
vollständig lesbare, tatsächlich leere Kostenhistorie ergibt dagegen Nullkosten.

Die Werkzeugkosten lassen sich über die Projektfreigabe auswerten, ohne
sämtliche Werkzeugbuchungen anderer Projekte öffnen zu müssen. Dazu enthalten
die Projektbereiche eine zusätzliche verschlüsselte Sicht auf ihre
Werkzeugnutzung. Ausgabe, Rückgabe, Umbuchung, nachträgliche Bewertung bislang
unbewerteter Buchungen und Löschen aktualisieren diese Sicht zusammen mit dem
ursprünglichen Werkzeugdatensatz. Die Befehle benötigen die jeweils betroffenen
Schreibrechte auch in diesen Projektbereichen.

## Welche Werte gelten

Ein Lieferschein verwendet den letzten Produktpreis vor oder zum Belegzeitpunkt.
Existiert noch kein früherer Preis, gilt der früheste spätere Datensatz. Bei
gleichen Zeitpunkten entscheidet die numerische Datensatzkennung. Mikrosekunden
bleiben dabei erhalten. Die Historien werden für einen Bericht einmal geordnet;
weitere Preisabfragen durchsuchen nur die Einträge des jeweiligen Produkts.

Materialgemeinkosten fallen einmal je Lieferschein mit Positionen an. Lohn- und
Nachunternehmergemeinkosten verwenden die jeweilige Kostensumme des Arbeitstags;
die Konstante wird je vorhandener Arbeitszeitart einmal angewendet. Externe
Arbeitsstunden zählen zu den Kosten, erhalten aber keinen Lohnzuschlag. Der
Gemeinkostensatz stammt jeweils vom Belegzeitpunkt beziehungsweise vom Beginn
des Arbeitstags in UTC.

Werkzeugbuchungen behalten ihren erfassten Tagessatz. Ein später geänderter
Werkzeugpreis ersetzt diesen historischen Satz nicht. Bei einer zeitlich
gefilterten Auswertung zählt für überlappende Buchungen weiterhin die gesamte
Buchungsdauer, einschließlich Anfangs- und Endtag in UTC. Die Dauer wird nicht
auf den Filterzeitraum gekürzt.

Die Auswertung bewahrt die bisherigen Gleitkommazahlen. Ein ausdrücklich nicht
erfasster Preis bleibt als `null` erkennbar und wird bei der Summe wie bisher
mit null Euro angesetzt. Ein fehlender oder nicht lesbarer Schlüsselbereich ist
kein solcher Datensatz und führt zur beschriebenen Zugriffsmeldung.

## Finanzbeträge bearbeiten und übernehmen

Manuelle Angebots- und Rechnungssummen liegen als eigene verschlüsselte
Datensätze vor. Anlegen, Ändern und Löschen haben getrennte Rechte. Eine stabile
Vorgangskennung verhindert, dass ein erneuter Speicherversuch denselben Betrag
doppelt anlegt. Für zugeordnete Vorgangsbeträge verweist die Oberfläche auf den
zugehörigen Vorgang. Sobald ein Hauptangebot die Vertragsgrundlage bildet,
werden zusätzliche Leistungen als Nachtragsangebot erfasst.

Die Bestandsübernahme erhält Kennungen, Zeitpunkte, Kommentare, ursprüngliche
Benutzerbezüge und vorhandene Vorgangszuordnungen. Manuelle Angebotssummen und
Rechnungseinträge werden in Einzelobjekte übernommen; angenommene Vorgangswerte
bleiben im Auftragsregister. Diese Trennung verhindert eine doppelte Zählung.

Übernommene Rechnungswerte mit Vorgangszuordnung liegen in unveränderlichen
Einzelobjekten. Weder das Entfernen der Zuordnung noch eine Löschmarkierung oder
ein fehlender Zeitnachweis erlaubt, den gespeicherten Wert umzuschreiben. Die
API prüft diese Sperre anhand des signierten Objektnamens; eine Datenbanksperre
schützt zusätzlich vor versehentlichen Änderungen.
[OpenTimestamps](zeitnachweise.md) kann den bereits gesperrten Stand später
bestätigen.

Der [Abrechnungsadapter](verschluesselte-abrechnung.md) verbindet jetzt auch
neue Rechnungen, Abschläge und Schlussrechnungen mit diesen Projektbuchungen.
Nummer, Dokumentensperre und Rechnungswert werden gemeinsam gespeichert.
Zahlungen verändern die ausgestellten Beträge nicht; sie werden gesondert
ergänzt. Fachliche Prüfungen geheimer Beträge bleiben Aufgabe des berechtigten
Clients.

Neue manuelle Finanzänderungen erscheinen im gemeinsamen Projektverlauf und
folgen dort ihrer jeweiligen Inhaltsfreigabe. Übernommene historische
Finanzeinträge bleiben bis zu einer eindeutigen Zuordnung ihrer alten Freigaben
im gesonderten Verlaufsbereich.

Der
[native Vergleichstest](../sortsys-webapp-v2/scripts/test-live-project-costs.ts)
erfasst vor der Umstellung sechs tatsächliche PostgreSQL-Berichte. Nach der
Übernahme prüft er dieselben Daten und Zeitfilter im Browser-Datenkern sowie
Finanzänderungen und Werkzeugbuchungen über zwei unabhängige API-Prozesse. Der
gemeinsame Lauf öffnet den Kostenstand außerdem nach zwei aufeinanderfolgenden
Seed-Recoveries. Große Datenbestände und schwächere Endgeräte sind noch nicht
vermessen.
