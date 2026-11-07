# Angebote, Aufträge und Abrechnung

Die Webapp trennt Angebote von Projekten. Ein Hauptangebot beginnt mit einer X83
oder einem direkt erfassten Leistungsumfang und wird in der verknüpften X84
kalkuliert. Abgabe und Annahme halten feste native Dokumentstände fest. Ein
angenommenes Hauptangebot kann genau ein neues Projekt erzeugen; sein Auftragswert
geht einmal in die Projektkostenübersicht ein. Weitere Angebote dieses Projekts
sind Nachträge. Angenommene Nachträge einschließlich Minderungen ändern den Auftragswert.

X85-Nebenangebote haben eigene Abgabe- und Annahmestände und behalten den Bezug zum
Hauptangebot. Angenommene Nebenangebote können ebenfalls Projektauftrag werden.

## Ältere Angebotsaufforderungen öffnen

Neben X83 kann die Schaltfläche für Leistungsanfragen D83 (GAEB 90) und P83
(GAEB 2000) öffnen. Der Client erkennt den Inhalt und überführt Festbreitenmengen,
OZ-Strukturen und GAEB-2000-RTF-Texte in eine schema-geprüfte X83. Die vollständigen
Originalbytes bleiben in einem reservierten XML-Kommentar erhalten. P83-Texte
werden übernommen, soweit der Parser sie unterstützt. Nicht unterstützte besondere
D83-Positionsarten werden abgelehnt; sie werden nicht in gewöhnliche bepreiste
Positionen umgedeutet. Fiktive Regressionsbeispiele stehen unter
[`scripts/fixtures/legacy/`](../scripts/fixtures/legacy/).

## Auftrag im Projekt

Unter **Auftrag & Leistungen** stehen angenommenes Angebot, Kunden-X86,
X87-Bestätigung, Nachträge, X31-Aufmaße und Nachunternehmerpakete zusammen.
Ein eingegangener Auftrag wird vor seiner Bestätigung mit dem Angebot verglichen.
Bestehende Projekte können ihren ursprünglichen X86-Auftrag einmal übernehmen;
historische Finanzbuchungen bleiben ohne erneute Auftragswertbuchung erhalten.

Projektformulare erstellen X31, X52, X93 und X89 aus einem angenommenen Auftrag.
X52-Kostenbestandteile zeigen Kennung, Menge, Einheit, optional Leistung und Wert
im Canvas-Editor.

Aufmaße verweisen auf einen angenommenen Auftrag oder Nachtrag. Vertragsmengen
bleiben von aufgemessenen Mengen getrennt.

## Leistungen weitervergeben

Weitervergaben erstellen aus gewählten
vollständigen Positionen eine neue X83 ohne Verkaufspreise und undurchsichtige
Herstellerdaten. Mehrere Nachunternehmer-X84 können verglichen werden; das gewählte
Angebot wird zum X86-Auftrag. Bereits vergebene Positionen können unter demselben
Auftrag nicht doppelt vergeben werden. X87-Dateien des Nachunternehmers halten die
Bestätigung fest. Abweichende Mengen und fehlende Angebotspositionen müssen vor
Vergabe geklärt werden.

## Preisanfragen und Bestellungen

X93-Preisanfragen enthalten keine Verkaufspreise. Empfangene X94-Angebote sind
unveränderlich; das gewählte Angebot wird bis zur Vergabe als native X96-Bestellung
bearbeitet. X97-Lieferantenbestätigungen bleiben unveränderlich. Handelsdateien
verwenden ihre native flache `OrderItem`-Struktur sowie native Preise und Preisbasen.
Der Editor erfindet dafür keine LV-Gruppen.

## Rechnungen und Zahlungen

X89-Entwürfe zeigen Beteiligte, Rechnungsdatum, Leistungszeitraum und Steuernummer.
Ausstellung vergibt serverseitig die konfigurierte Rechnungsnummer, hält einen
nativen Stand fest und bucht den Nettobetrag einmal. Zahlungen sind separate
Datensätze; Teil-/Vollzahlungsstände folgen dem exakten offenen Bruttobetrag.
Leistungsbezogene und pauschale Abschlagsrechnungen verwenden periodische
Abrechnung. Eine Schlussrechnung setzt ausgestellte Abschlagsrechnungen voraus
und zieht diese unabhängig vom Zahlungsstand ab. Eine gewöhnliche Rechnung steht
nur für Aufträge ohne Abschlagsrechnungen bereit. Nicht unterstützte Abrechnungs-
oder Preisregeln bleiben einsehbar und gelangen nicht unbemerkt in diese Abläufe.

## Organisation einrichten

Verwaltung → Organisation hält Unternehmensname und Anschrift für neue Angebote
und Preisanfragen bereit. Reiter trennen Unternehmensdaten, Rechnungsnummern,
Dokumentvorlagen, Logo, Personalvorgaben und LLM-Nutzung. Formularentwürfe bleiben
beim Reiterwechsel erhalten. Native Anschriften sind bearbeitbar; das Aktualisieren
einer Kalkulation erhält die bereits eingetragene Anschrift. Im Dokument steht
die Empfängeranschrift. Die interne Aufmaßbezeichnung bleibt vom Bauvorhaben
und vom Leistungsverzeichnis getrennt.

Rechnungsnummern können global fortlaufend, mit getrenntem oder kompaktem Datum
sowie projektlokal oder projektbezogen global fortlaufend vergeben werden.
Eine exakte dezimale Startnummer und fünf aufeinanderfolgende Vorschaunummern
zeigen das Ergebnis. Der Projektteil verwendet die letzten acht Dezimalziffern
der decodierten öffentlichen Projekt-ID mit führenden Nullen. Dieser feste
Ausschnitt ist nicht kollisionsfrei; die Rechnungsvergabe erzwingt die Eindeutigkeit
zusätzlich. Die Zähler werden bei Ausstellung transaktional vergeben.
Die [Druckvorlagen](technik.md#druckvorlagen) werden ebenfalls unter Organisation eingerichtet.

## Quelldateien und Dokumentstände

Quelldateien und Verweise auf deren Stände bleiben erhalten. Ableitungen verwenden
GAEB 3.3. Nicht unterstützte Preis- oder Positionsregeln stoppen die Ableitung
ausdrücklich, statt Daten zu verlieren. Der Ablauf verwendet derzeit EUR; die
native Bearbeitung erhält andere Währungen und Spezialdaten. X86→X87 erhält den
vollständigen Auftrag samt Preisregeln und Beteiligten. Diese Abläufe erfassen
Abgabe, Annahme und Vergabe. Das Versenden an Kunden oder Lieferanten bleibt eine
ausdrückliche Aktion außerhalb des Editors. `projects.create` bleibt für vorhandene
API-Clients verfügbar; neue Produktoberflächen beginnen beim Angebot.
