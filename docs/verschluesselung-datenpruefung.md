# Datenkonsistenz ohne Klartextzugriff der API

Der erste Ausbau verwendet weder eine vertrauenswürdige Ausführungsumgebung noch
einen separaten abgeschirmten Datendienst. Geschäftliche Änderungen bleiben für
die API verschlüsselt. Eine Klartextprüfung durch den Server ist ausdrücklich
nicht vorgesehen. Die Ausnahme für aufgerufene LLM- und OCR-Funktionen begründet
kein allgemeines Entschlüsselungsrecht für Datenänderungen.

Für [Abwesenheitsanträge und Entscheidungen](abwesenheiten-protokoll.md) ist die
technische Trennung der Schreibrechte bereits eingebaut. Anträge und
Entscheidungen bleiben unveränderlich; öffentliche Referenzen sichern die
Reihenfolge von Genehmigung und Rücknahme. Der Fachadapter prüft die
Antragsinhalte, bindet jede Entscheidung an die exakte Antragssignatur und
gleicht bei neuen Einträgen den genannten Urheber mit dem tatsächlichen
Unterzeichner ab. Für übernommene Altdaten ist stattdessen ein zusätzlicher
Nachweis der Mandantenautorität erforderlich.

Damit gelten geringere Konsistenzgarantien als bei einer API, die alle Inhalte
prüfen kann. Eine Benutzersignatur belegt den Absender einer Nachricht, aber
nicht die Gültigkeit ihrer entschlüsselten Werte. Auch die Behauptung eines
Clients, ein Dokument sei schema-valide, ist kein serverseitig überprüfbarer
Nachweis.

## Was die API verbindlich prüft

Die folgende Tabelle beschreibt die angestrebten Garantien des Fachschemas. Der
Draft setzt zunächst die Prüfung signierter Datenhüllen, Schlüsselbereiche und
Versionen um. Öffentliche Projektverweise und Rechnungsabläufe müssen bei der
Umstellung ihrer bisherigen Datenwege noch damit verbunden werden.

Öffentlich bleiben technische Kennungen, Beziehungen, Schema-Versionen und die
zur Autorisierung nötigen Informationen. Nachrichten haben ein festes Schema;
unbekannte äußere Felder und unzulässige Größen werden abgelehnt.

| Eigenschaft                                                                | Serverseitige Garantie                                      |
| -------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Erlaubte äußere Felder, Nachrichtentyp und Protokollversion                | Ja                                                          |
| Längen und Kodierung von Schlüsseln, Signaturen und Chiffraten             | Ja                                                          |
| Mandant, bestätigte Identität, Signatur und erlaubte Aktion                | Ja                                                          |
| Öffentliche Objektverweise, Fremdschlüssel und Eindeutigkeitsregeln        | Ja                                                          |
| Aktuelle Rechte, Schlüsselgeneration, Versionskonflikte und Wiederholungen | Ja                                                          |
| Technische Rechnungsnummern und öffentliche Statusübergänge                | Ja, soweit ihre Voraussetzungen öffentlich überprüfbar sind |
| Entschlüsselbarkeit einer Nachricht eines böswilligen Schreibers           | Nein                                                        |
| Verborgene Pflichtfelder und der Typ eines verschlüsselten Werts           | Nicht allein aus dem Chiffrat beweisbar                     |
| Mengen, Preise, Rundung, Steuer und fachliche Summenkonsistenz             | Nein                                                        |
| GAEB-XSD und verlustfreie Behandlung unbekannter XML-Inhalte               | Nicht serverseitig; Prüfung im berechtigten Client          |

Eine verwaltete Tabellen- oder Baumstruktur kann unabhängig vom verschlüsselten
Text verhindern, dass beliebige Anwendungsfelder angelegt werden. Der Server
akzeptiert deshalb keine vom Client frei gewählten Tabellennamen, SQL-Abfragen
oder unbeschränkten Eigenschaften. Öffentliche Beziehungen bleiben mit ihren
existierenden Objekten verknüpft.

Bei fein aufgeteilten Daten können auch Feldnamen und die deklarierte
Wertrepräsentation feststehen. Ein Geldfeld kann beispielsweise als exakte
Ganzzahl mit festgelegter Skalierung kodiert werden. Das vermeidet freie
JSON-Objekte an dieser Stelle. Eine passende Chiffratlänge beweist aber
weiterhin weder einen gültigen Authentifizierungstag noch einen fachlich
zulässigen Preis.

Ein Löschrecht lässt sich bei ganzen Objekten ohne Klartextprüfung von einem
Bearbeitungsrecht unterscheiden. Der Browser veröffentlicht einen signierten
Löschdatensatz mit leerem verschlüsseltem Inhalt. Die API prüft dessen Format,
Länge, Version und Löschrecht; eine beliebige Inhaltsänderung unter diesem Recht
wird nicht akzeptiert. Der Browser prüft vor dem Ausblenden zusätzlich die
Signatur und das damalige Recht des Autors. Der
[Datenkern](clientseitige-datenlaufzeit.md#löschen-mit-eigenem-recht) beschreibt
auch die Grenzen bei Sammelobjekten und den Unterschied zur physischen Löschung.

## Verantwortung der Clients

Beim Lesen prüft der gemeinsame Datenkern auch die damalige Schreibfreigabe des
Absenders. Dazu gehören die signierte Rechteregel der angegebenen Version, die
Identität unter der zugehörigen Mandantengeneration und gegebenenfalls der
bestätigte Ursprung eines neu angelegten Projekts oder Dokuments. Ein Leser kann
mit seinem Bereichsschlüssel zwar eigene Chiffrate und Signaturen erzeugen; ohne
damaliges Schreibrecht werden diese beim Empfänger abgewiesen. Frühere zulässige
Änderungen bleiben auch nach einem Rechteentzug lesbar.

Diese Prüfung bestätigt keine globale Aktualität. Ein böswilliger Speicherdienst
könnte einen vollständigen älteren, korrekt signierten Stand erneut liefern.
Gegen solche Rücksetzungen und auseinanderlaufende Ansichten wäre ein
unabhängiger Aktualitätsnachweis nötig. Die historischen Freigaben allein
liefern ihn nicht.

Vor dem Verschlüsseln prüft der Client die eingegebenen Daten. Nach dem
Entschlüsseln prüft jeder Empfänger seine lesbaren Bestandteile erneut anhand
eines festen Schemas. Unbekannte Anwendungsfelder, ungültiges UTF-8, falsche
Datentypen und unerlaubte Änderungen an geschützten Bestandteilen dürfen nicht
ungeprüft in das Arbeitsmodell übernommen werden. Entschlüsselte Objekte werden
nicht beliebig mit bestehenden Anwendungsobjekten zusammengeführt.

Ein empfangener Dokumentstand kann deshalb kryptografisch authentisch und
serverseitig angenommen sein, aber beim Empfänger die Inhaltsprüfung nicht
bestehen. Dieser Fall erhält einen eigenen Fehlerzustand. Der letzte geprüfte
Stand bleibt verfügbar; die ungültige Änderung wird nicht still als gültiger
Inhalt dargestellt, automatisch repariert oder durch einen unvollständig
berechtigten Client überschrieben. Ein berechtigter Bearbeiter kann einen
geprüften früheren Stand als neue Version wiederherstellen.

Ein schreibberechtigter Benutzer kann weiterhin die Verfügbarkeit seiner
bearbeitbaren Inhalte beeinträchtigen. Ohne zusätzliche vertrauenswürdige
Prüfung oder passende kryptografische Beweise kann die API diesen Fall nicht
vollständig ausschließen. Die Historie und getrennte Berechtigungsbereiche
begrenzen die Folgen, ersetzen diese fehlende Garantie aber nicht.

Summen und andere berechenbare Anzeigen werden möglichst aus den entschlüsselten
Quelldaten abgeleitet. Ein frei veränderbares Summenfeld ist kein Ersatz für die
Berechnung aus Menge, EP, Nachlässen und Steuern. Berechtigte Clients teilen und
versionieren die Fachlogik. So sollen identische Quellstände identische
Ergebnisse liefern; das ist durch Vergleichstests nachzuweisen.

Vorzeichenregeln hängen von der Fachoperation ab. Ein negativer Maßansatz kann
ein zulässiger Abzug sein. NaN, unendliche Werte und unzulässige Zahlenformate
sind keine Geldbeträge. Numerische Genauigkeit und Rundungsregeln bleiben
ausdrücklich Teil der Clientprüfung.

Die vorbereitende Bestandsumstellung überträgt Ganzzahlen und Dezimalwerte als
Zeichenfolgen. Auch JSON-Felder bleiben als JSON-Text erhalten: Eine darin
gespeicherte Kennung wie `9223372036854775807` darf auf dem Weg nach DuckDB
nicht durch JavaScripts Zahlentyp gerundet werden. SQL-`NULL` und der JSON-Wert
`null` bleiben unterscheidbar. Die lokale Übernahme veröffentlicht einen Bestand
erst, wenn seine Tabellen einschließlich aller Fremdschlüssel gemeinsam geprüft
sind. Eine abgebrochene oder fehlerhafte Übernahme hinterlässt keine
Teilbestände. Der Schema-Abgleich umfasst auch Eindeutigkeitsregeln mit
Bedingungen oder Ausdrücken. So dürfen zwei noch nicht freigegebene Vorlagen
denselben Namen tragen; bei der Freigabe muss der Name eindeutig sein.
Produktkategorien dürfen sich für dasselbe Produkt nicht nur in der
Großschreibung unterscheiden.

## Zusammenarbeit und Teilrechte

Verschlüsselte Änderungen werden an Lese- und Schreibgrenzen getrennt. Eine
Yjs-Nachricht darf nicht allein wegen einer äußeren Feldbezeichnung als erlaubte
Änderung eines beliebigen Gesamtdokuments gelten. Clients wenden Updates zuerst
auf einen getrennten Prüfzustand an und übernehmen ausschließlich einen gültigen
resultierenden Zustand innerhalb ihres erlaubten Änderungsumfangs.

Ein nur teilweise berechtigter Client prüft seine lesbaren Bereiche. Er kann
keine vollständige Rechnung oder ein vollständig verborgenes XML-Dokument als
fachlich korrekt bestätigen. Freigaben müssen deshalb an den tatsächlich
geprüften Stand und den ausgewiesenen Prüfumfang gebunden sein. Ein
gespeichertes Clienturteil ist ein signierter Hinweis dieses Clients, kein
allgemeiner Gültigkeitsbeweis für andere Empfänger.

## Mögliche spätere Erweiterungen

Ein vom Mandanten kontrollierter oder attestiert abgeschirmter Prüfdienst könnte
später vor der verbindlichen Annahme alle benötigten Inhalte prüfen. Dafür wären
separate Dienstidentitäten, begrenzte Schlüsselfreigaben und an konkrete
Chiffrate und Ausgangsversionen gebundene Prüfnachweise erforderlich. Ein
gewöhnlicher Provider-Container mit Datenschlüsseln wäre kein solcher Dienst.

Zero-Knowledge-Beweise können einzelne Aussagen über geheime Werte absichern.
Ein Bereichsnachweis für eine Zahl ersetzt jedoch keine allgemeine Prüfung von
GAEB-Texten, XML-Erweiterungen und Rechnungsabläufen. Für den ersten Ausbau
werden solche Beweise nicht als bereits verfügbare Garantie vorausgesetzt.
