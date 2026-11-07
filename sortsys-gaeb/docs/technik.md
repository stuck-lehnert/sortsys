# Technischer Aufbau des GAEB-Editors

Der Host stellt Dateispeicher und Berechtigungen bereit. Die Dokumentverarbeitung
läuft im Browser. Ein Einbindungsbeispiel steht in der [Paket-README](../README.md).

Bei der sortsys-Einbindung bleiben Dialog und Fokusbereich beim Laden, Anlegen
und Wechseln nativer Dokumente bestehen. Ladeanzeigen für Angebote und native
Dokumente stehen mittig im Vollbilddialog, ohne dessen Fokusbereich auszutauschen.

## Canvas und Eingabe

Das Dokument wird auf einer durchgängigen Canvas-Fläche ohne Seitenumbrüche
gezeichnet. Das gilt für Text, Listen, Tabellen und Preise ebenso wie für die
Textauswahl und den Cursor. Unsichtbare Canvas-Kacheln begrenzen den Speicherbedarf
langer Dokumente. Die sichtbare Darstellung verwendet kein DOM-Textlayout,
`contenteditable` oder HTML-Tabellen.

Ein verborgenes natives Textfeld übernimmt Tastatur, IME und Zwischenablage und
bleibt bei Layoutänderungen erhalten. Zusätzliche unsichtbare Bedienelemente sind
für Tastatur und Hilfsmittel zugänglich. Texte, Mengen und Preise lassen sich
direkt bearbeiten. Auswahlformatierung, Absätze, Suche, neue Positionen und
Rückgängig/Wiederholen verwenden für alle unterstützten Phasen dieselbe Eingabelogik.
Strukturierte Texte bleiben GAEB XML; ein schreibgeschützter Modus ist verfügbar.
Berührungen behalten
den nativen Eingabefokus auch bei nachfolgenden Kompatibilitäts-Mausereignissen.

Der Zoom funktioniert per Trackpad einschließlich Safari-Gesten,
Strg/Cmd+Mausrad oder Zahleneingabe. Bei Gesten bleibt der Punkt unter dem
Zeiger erhalten. Die Breitenanpassung folgt der Fenstergröße. Während einer
Zoomgeste wird die vorhandene Bitmap verwendet; erst danach wird neu gezeichnet.
Dabei werden Editorzoom und aktuelle Pixeldichte berücksichtigt, auch nach einem
Bildschirmwechsel.

Die Kachelhöhe passt sich so an, dass eine Bitmap selbst bei maximalem Zoom
höchstens acht Megapixel umfasst. Alle Kacheln teilen Dokumentkoordinaten und
Geräteraster. Dadurch verlaufen Feldmarkierungen, Auswahl, Unterstreichungen
und Tabellenlinien über die Grenzen hinweg.

Textmessungen und unveränderte Positionslayouts werden zwischengespeichert.
Kacheln zeichnen nur die Befehle innerhalb ihrer Grenzen, auch bei schnellem
Tippen. Zeichenbefehle und Trefferflächen behalten ihre Identität, bis sich
Inhalt oder Koordinaten ändern; die Verteilung auf Kacheln benötigt einen
Durchlauf. Unveränderte Kacheln und die Gliederung überspringen beim Tippen die
React-Reconciliation.

Der Kopf zeigt Dokumentüberschrift und Auftragsdaten. Von links nach rechts
folgen Positionsnummer, Beschreibung, Menge, Einheit, EP und Summe. Die Preis-
und Summenspalten wachsen mit ihrem Inhalt und zeigen die Dokumentwährung.
Langtexte fließen weiter. Netto-, Umsatzsteuer- und Gesamtsummen erscheinen,
wenn die entsprechenden Werte vorliegen.
Positionsnummer, Beschreibung und Menge teilen eine Textgrundlinie, auch bei
importierten Schriftgrößen.
Gruppentitel beginnen auf derselben horizontalen Position wie Positionstexte und
verwenden je Ebene 20/18/17/16/15 px.
Absätze haben sechs Pixel Abstand; Positionszeilen bleiben kompakt.

## Hierarchie im XML

Zweige dürfen unterschiedlich tief sein; sichtbare Füllgruppen entstehen nicht.
Vom Schema benötigte Zwischencontainer tragen reservierte `sortsys_direct_`-IDs
und bleiben in Gliederung und Zeichnung verborgen. Native Positions-IDs und
offizielle Ordnungszahlen bleiben erhalten; ungenutzte tiefere Nummernstufen
erscheinen als `_`. Dieselbe Abbildung bleibt beim Ableiten und Wiederöffnen von
X83/X84/X86/X87/X31 erhalten. Umsortieren erhält geerbte Namensräume und schützt
indizierte, alphanumerische sowie referenzabhängige Nummerierungen. Beim
Aktualisieren einer Kalkulation folgen Preise den IDs; neue Positionen übernehmen
keinen alten Preis einer wiederverwendeten Nummer. Verknüpfte X84/X31 übernehmen
die Hierarchie des Quelldokuments. Die globalen GAEB-Regeln erläutert die
[offizielle Spezifikation, Abschnitte 4.2.2–4.3.4](https://www.gaeb.de/wp-content/uploads/2021/07/Fachdokumentation_GAEB-DA-XML_3.3_2021-05.pdf).

## Positionsindex

sortsys indiziert Kurz- und Langtexte bestehender Dokumente.
Der mandantenbezogene Metadatenindex ersetzt keine Originaldatei. Eigenständige
Editoren verwenden eine abgegrenzte IndexedDB-Historie; Host-Anwendungen können
`searchPositions` und `positionLibraryScope` bereitstellen.

## Speichern und Zusammenarbeit

Automatisches Speichern übernimmt fokussierte Eingaben nach einer kurzen
Schreibpause, prüft vor dem Schreiben, arbeitet Anfragen nacheinander ab und
wiederholt fehlgeschlagene Versuche. IndexedDB hält unbestätigtes XML und
unvollständige Feldeingaben für Benutzer und Dokument zur Wiederherstellung vor.
Ungültige Eingaben warten auf Korrektur, statt endlos erneut gesendet zu werden.
Statusmeldungen erscheinen nur bei Problemen. Einheiten beachten das GAEB-Limit
von vier Zeichen.
Übliche Namen wie „Stück“ und „pauschal“ werden zu „Stk“ und „psch“; unbekannte
Einheiten werden nie abgeschnitten. Host-Anwendungen können Fehler mit dem
betroffenen Verarbeitungsschritt protokollieren, ohne Dokumentinhalte aufzunehmen.

Authentifizierte WebSocket-Sitzungen gleichen gemeinsame Texte vor dem Speichern
über Yjs/yrs ab. Farbige Cursor und Auswahlen folgen den Textpositionen.
Einfügungen und Löschungen im selben Feld laufen zusammen; Rückgängig entfernt
nur eigene Operationen. Vorgangs- und Dokumentmetadaten kommen über dieselbe
Verbindung. Der Browser fragt nach dem Speichern nicht den ganzen Vorgang erneut ab.

API-Instanzen teilen sich ein PostgreSQL-Änderungsprotokoll, eine einheitliche
Feldinitialisierung und zeitlich begrenzte Anwesenheitsdaten. Mandantenbezogenes
LISTEN/NOTIFY überträgt kleine Textänderungen und bestätigte Datei-/Vorgangsänderungen
zwischen Instanzen. Feste Instanzzuordnung oder ein separater Dokumentdienst sind
nicht nötig. Gesicherte Zwischenstände begrenzen, wie viele Änderungen beim
Wiederverbinden nachgeladen werden müssen. Nach Verbindungsverlust holt ein
Listener Änderungen aus dem Protokoll nach. Pro aktivem Mandanten und
API-Instanz besteht eine zusätzliche Listener-Verbindung, die nach einer Minute
Inaktivität schließt. Cursoränderungen werden alle 100 ms zusammengefasst,
Berechtigungen und Gültigkeit alle 30 Sekunden geprüft. Kurzlebige,
dokumentbezogene Tickets stehen in der ersten Socket-Nachricht, nie in der URL.
Sitzungs- und Projektzugriff werden während der Verbindung erneut geprüft.

Beim Speichern wird das lokale XML mit dem Ausgangsstand und dem aktuellen
Serverstand verglichen (Drei-Wege-Abgleich). Das geschieht getrennt vom gemeinsamen
Feldtext. Unabhängige Felder werden zusammengeführt, reproduzierbare
Summen neu berechnet. Widersprüchliche Preise oder überlappende Struktur- und
Formatänderungen erhalten die lokale Wiederherstellungskopie und melden einen
Konflikt. Mengen und Preise sind keine Zeichen-CRDTs. Fremde Änderungen entfernen
Rückgängig-Schnappschüsse der Gesamtdatei, damit Rückgängig keine fremde Arbeit
verwirft. Nach Wiederverbindung wird das Dokument vor dem Fortsetzen aktualisiert.

## Aufmaß im XML

Der Ausdrucksparser rechnet begrenzt mit exakten rationalen Zahlen,
akzeptiert Dezimalkomma/-punkt und ×/x/* und führt kein JavaScript aus.

Jeder unterstützte Ansatz schreibt eine ausführbare native REB-FN91-Zeile und
aktualisiert die X31-Menge. Form, vollständige Beschreibung und Ortsbezeichnung
bleiben in versionierten XML-Kommentaren erhalten, ohne das offizielle Schema
zu ändern; native Adressen bleiben stabil. Vorhandene FN91-Zeilen sind als
Formeln bearbeitbar. Reine Mengendateien behalten ein ausdrücklich ausgewiesenes
übernommenes Aufmaß; nicht unterstützte REB-Zeilen behalten Bytes und Basismenge.
Inkonsistente extern bearbeitete Summen oder Metadaten stoppen unterstützte
Änderungen. Unabhängige Zeilenänderungen werden vor der Summenberechnung vereinigt,
widersprüchliche fachliche Eingaben bleiben geschützt. REB 2009 summiert exakte
Ansätze vor der Mengenrundung; REB 1979 rundet einzelne Ansätze. Bei X31 in der
Ausgabe 2023 bleiben eingebettete PDFs und Bilder erhalten. Anlagen lassen sich
hinzufügen und herunterladen.
Das native Zeilenformat folgt [GAEB 3.3, §7](https://www.gaeb.de/wp-content/uploads/2023/09/Fachdokumentation_GAEB-DA-XML_3.3_2023-01.pdf).

## Originaltreue und fachliche Grenzen

Bearbeitungen anhand der Quellpositionen erhalten unangetastetes XML bytegenau,
einschließlich Kommentaren, CDATA, Namensräumen, Attributen und Herstellererweiterungen.
Herstellernamensräume werden nur aus dem vorübergehenden XSD-Prüfbaum entfernt,
entsprechend dem GAEB-Prüfprogramm.

Mengen und Einheitspreise verwenden Festkommaarithmetik und kaufmännische Rundung.
Vorhandene Positions-, Gruppen- und LV-Summen sowie einfache Nachlässe werden
aktualisiert. Besondere Preisregeln – Alternativgruppen, HoldOut-Positionen,
Zuschlagspositionen, Preisanteile, Teilmengen, Pauschalüberschreibungen und getrennte
Umsatzsteuersummen – bleiben erhalten. Die automatische Preisbearbeitung ist für
solche Dokumente gesperrt, bis eigene Fachregeln und Tests dafür vorliegen.

Adressblöcke zeigen ausschließlich den postalischen Empfänger ohne Rollenüberschrift.
Reduzierte X84/X31 verwenden nötigenfalls den Empfänger der verknüpften Quelle.
Andere Beteiligte bleiben im nativen XML; Absenderdaten sind für Vorlagen verfügbar.
Die interne Aufmaßbezeichnung bleibt von Bauvorhaben und LV getrennt, auch nach
Wiederöffnen und in der Typst-Ausgabe.

Signierte Dokumente öffnen schreibgeschützt. DTDs werden abgelehnt, Schemas lokal
mitgeliefert und Prüfungen in einem abbrechbaren Worker ausgeführt. Dokumente sind
auf 20 MiB, einzelne Anlagen auf 10 MiB begrenzt. Dokument-HTML und URLs werden
beim Darstellen nie ausgeführt. sortsys prüft Speicherberechtigungen und Revisionen
und schreibt neue Objektschlüssel vor Bestätigung der Metadaten. Ein fehlgeschlagener
Speicherversuch ersetzt so kein bestehendes Dokument. Die Rückfrage beim Schließen
mit ungesicherten Änderungen übernimmt der Host-Dialog.

XRechnung/ZUGFeRD, X89B, Signaturerzeugung sowie der übrige REB-Formelkatalog mit
abhängigen Adressverweisen sind gesonderte Erweiterungen. Eine erfolgreiche
XSD-Prüfung bestätigt das Schema; sie ist keine GAEB-/BVBS-Zertifizierung und
keine vollständige kaufmännische Prüfung.

## Druckvorlagen

Unter Verwaltung → Organisation → Dokumentvorlagen stehen ein Monaco-Typst-Editor
und eine direkte PDF-Vorschau nebeneinander. Vorlagen definieren
`document-header(data)`, `document-footer(data)`, `table-style` und
`document-style(data, body)`. Erzeugte native Dokumentdaten bleiben vom
bearbeitbaren Vorlagentext getrennt. Derselbe lokale Compiler, dieselben
mitgelieferten Schriften und dieselbe Vorlage versorgen Drucken und Strg/Cmd+P.
Drucken erzeugt ein PDF mit Seiten; der interaktive Canvas bleibt durchgängig.
Compilerfehler zeigen Diagnosen und erhalten die letzte gültige Vorschau.
Speichern prüft den erwarteten Vorlagenstand und schützt Entwürfe bei gleichzeitiger Änderung.

Administratoren können Bilder und PDFs mit jeweils bis zu 20 MiB hochladen.
`#asset("logo.png", width: 30mm)` bettet ein Bild ein,
`#asset("terms.pdf", page: 1, width: 100%)` eine PDF-Seite und
`#attachment("terms.pdf", width: 100%)` alle Seiten. Bilder werden zu PNG
normalisiert, PDF-Seiten vor dem Kompilieren lokal mit PDF.js gerendert.
Vorbereitete Seiten und Gesamtspeicher sind begrenzt. Vorlagentexte und
Dateimetadaten gehören zur Organisation; Binärdateien liegen privat im
Objektspeicher und werden über signierte URLs geladen. Der Compiler läuft
vollständig im Browser.

## Testabdeckung

Browsertests mit dem Produktionsbuild prüfen bytegenauen XML-Erhalt, alle
unterstützten Phasen, eingebettete X31-Daten, die durchgängige Dokumentansicht,
Gestenzoom mit festem Bezugspunkt, automatisches Speichern und Wiederherstellung. Die Browser-Suite der
Host-Anwendung prüft zwei gleichzeitige Editoren, gemeinsame Summen, Anwesenheit
und Wiederverbindung. API-Tests prüfen zusätzlich echte S3-/PostgreSQL-Schreibzugriffe,
dokumentbezogene Zugriffstickets, Socket-Bereinigung, Revisionen, Projekttrennung
und Anmeldung.

Herkunft der Originalschemas und Archivprüfsummen: [GAEB-Schemas](../vendor/gaeb/README.md).

Die Regressionsbeispiele unter [`scripts/fixtures/native-seed`](../scripts/fixtures/native-seed/README.md) entstehen mit den
tatsächlichen Seed-Konstruktoren der API. Browserprüfungen validieren die Dateien
gegen die offiziellen Schemas. Sie prüfen außerdem die Bearbeitung und Ableitung
der Dokumente, Umsatzsteuerberechnungen mit Festkommaarithmetik und die Abrechnung.
