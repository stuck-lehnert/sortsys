# sortsys GAEB

**Angebote kalkulieren, Aufmaße erfassen und gemeinsam am Original arbeiten – direkt im Browser.**

Die eigenständige GAEB-Editorsuite im sortsys-Monorepo verbindet eine vertraute
Dokumentansicht mit den Abläufen von Auftragnehmern. Bearbeitet wird die originale
X-Datei. Das Öffnen überführt sie in kein separates Datenbankmodell. Parsing,
Canvas-Darstellung, Dezimalberechnungen und XSD-Prüfung laufen lokal; die
Host-Anwendung stellt versionierten Dateispeicher bereit.

```sh
cd sortsys-gaeb
bun install --frozen-lockfile
bun run dev
```

`bun run build` erzeugt eine eigenständige statische Anwendung und den
ES-Modul-Einstieg `dist/editor.js`. Änderungen werden automatisch gespeichert.
Die eigenständige Anwendung schreibt geöffnete Dateien über die File System
Access API des Browsers. Ohne diese API hält sie das Dokument in IndexedDB und
bietet einen ausdrücklichen Dateidownload an. Die sortsys-Einbindung speichert die
bestehende Projektdatei. Beim Schließen werden ausstehende Änderungen gespeichert;
eine Rückfrage erscheint nur, wenn das Speichern tatsächlich fehlschlägt.

```tsx
import { GaebEditor } from "@sortsys/gaeb";
import "@sortsys/gaeb/styles.css";

<GaebEditor
  xml={xml}
  fileName="Angebot.x84"
  locale="de"
  canEdit={canEdit}
  onSave={saveExistingFile}
  onDirtyChange={setDirty}
/>;
```

## Dateiformate und Dokumentdarstellung

- Direkt bearbeitbar sind X80, X83–X87, X31, X52, X89, X93 und X96. X81/X82 sowie empfangene X94/X97 werden schreibgeschützt geöffnet. Namensraum und GAEB-Header bestimmen die Phase; eine abweichende Dateiendung wird gesondert gemeldet.
- Enthalten sind die offiziellen GAEB-XML-3.3-LV-Schemas von 2021-05, X31 von 2021-05 und 2023-01 sowie ältere Schemas für 3.2 und 3.1. Version oder Phase werden nicht stillschweigend umgewandelt.
- Eine durchgängige Canvas-Fläche zeigt Text, Typografie, Zeilenumbrüche, Listen, Tabellen, Preise, Auswahl und Cursor ohne Seitenumbrüche. Unsichtbare Canvas-Kacheln begrenzen den Speicherbedarf langer Dokumente. Ein verborgenes natives Textfeld übernimmt Tastatur, IME und Zwischenablage und bleibt bei Layoutänderungen erhalten. Unsichtbare semantische Bedienelemente ermöglichen Tastatur- und Hilfsmittelzugriff. Die sichtbare Darstellung verwendet weder DOM-Textlayout noch `contenteditable` oder HTML-Tabellen.
- Texte, Mengen und Preise lassen sich direkt bearbeiten. Dazu kommen Auswahlformatierung, Absätze, Suche, neue Positionen, Rückgängig/Wiederholen und ein schreibgeschützter Modus. Strukturierte Texte bleiben GAEB XML. Alle unterstützten Phasen verwenden dieselbe Canvas- und Eingabelogik.
- Trackpad-Zoom einschließlich Safari-Gesten, Strg/Cmd+Mausrad und numerischer Zoom halten den Punkt unter der Geste fest. Die Breitenanpassung folgt der Fenstergröße. Bitmaps werden für Editorzoom und aktuelle Pixeldichte neu gezeichnet, auch beim Bildschirmwechsel. Adaptive Kachelhöhen begrenzen jede Bitmap selbst bei maximalem Zoom auf acht Megapixel. Gemeinsame Dokumentkoordinaten und ein einheitliches Geräteraster halten Feldmarkierungen, Auswahl, Unterstreichungen und Tabellenlinien über Kachelgrenzen hinweg zusammen.
- Während Zoomgesten wird die vorhandene Bitmap verwendet und anschließend neu gerastert. Textmessungen und unveränderte Positionslayouts werden zwischengespeichert. Kacheln zeichnen nur die Befehle innerhalb ihrer Grenzen, auch bei schnellem Tippen. Zeichenbefehle und Trefferflächen behalten ihre Identität, bis sich Inhalt oder Koordinaten ändern; die Verteilung auf Kacheln benötigt einen Durchlauf. Unveränderte Kacheln und die Gliederung überspringen beim Tippen die React-Abstimmung. Die Schema-Prüfung läuft automatisch und benötigt keinen Menübandbefehl.
- Aktionen heißen fachlich etwa „Neues Angebot“ und „Neues Aufmaß“. Technische Phasenkennungen gehören in Dateinamen und Schema-Diagnosen.
- Auftragnehmerdokumente verwenden ein einheitliches Angebotslayout: Dokumentüberschrift und Auftragsdaten, Positionsnummer links, Beschreibung sowie Menge, Einheit, EP und Summe rechts davon. Kompakte Preis- und Summenspalten wachsen mit ihrem Inhalt und zeigen die Dokumentwährung. Langtexte fließen weiter; Netto-, Umsatzsteuer- und Gesamtsummen erscheinen, wenn diese Werte vorliegen. Steuersätze und Dokumentdaten werden nicht aus einer Bildschirmvorlage erfunden.

## Direkt bearbeiten und klar navigieren

Bearbeitbare Felder haben dezente blaue Hintergründe und gestrichelte, rechteckige
Rahmen. Deutlichere Linien bei Fokus und Mausberührung sowie der Mauszeiger
kennzeichnen die Eingabe; die Feldanzeige lässt sich abschalten. Textauswahl folgt
dem Zeiger über die ursprüngliche Trefferfläche hinaus, behält ihre Richtung bei
und scrollt an Fensterrändern. Feldfokus verändert den gewählten Zoom nicht.
Gedruckt werden keine Eingabemarkierungen.

Doppelklick markiert ein Wort, Dreifachklick den vollständigen Absatz einschließlich
umgebrochener Zeilen. Bereits beim Drücken der Maustaste gilt die endgültige
Auswahl. Ziehen erweitert sie wort- oder absatzweise, ohne kurz zum Cursor
zusammenzufallen. Ein Klick auf leeres Papier, Arbeitsfläche oder Gliederung
entfernt Cursor und Auswahl, übernimmt offene Eingaben und hält den Tastaturfokus
im Vollbilddialog. Formatierungsbefehle erhalten die Auswahl. Berührungen behalten
den nativen Eingabefokus auch bei nachfolgenden Kompatibilitäts-Mausereignissen.
Positionsnummer, Beschreibung und Menge teilen eine Textgrundlinie, auch bei
importierten Schriftgrößen.

### Gliederung wie ein Dateibaum

Ausgewählte Gruppen nehmen neue Einträge auf; bei ausgewählten Positionen gilt
deren übergeordnete Gruppe. Neue leere Gruppen werden direkt im Baum benannt.
F2 oder das Eintragsmenü benennt um, Enter oder Fokusverlust übernimmt, Escape
bricht ab. Ein Klick auf Gruppennamen klappt sie ein oder aus; die Werkzeugleiste
kann alle einklappen. Kontext- und Zeilenmenüs bieten dieselben Aktionen für Maus,
Tastatur und Berührung. Neue Gruppen verschieben keine vorhandenen Positionen
ungefragt. Beim Anlegen werden eingeklappte übergeordnete Gruppen geöffnet.

Zeilen lassen sich zwischen Positionen und Gruppen einsortieren, auf Gruppen
ablegen oder über „Gesamtes Dokument“ auf die oberste Ebene verschieben. Auch der
direkte Wechsel in eine beliebige übergeordnete Gruppe ist möglich. Eingeklappte
Gruppen öffnen sich beim längeren Darüberhalten; Einfügelinien und hervorgehobene
Gruppen zeigen das Ziel. Teilbäume ziehen gemeinsam um. Tastaturziehen und
Alt+Auf/Ab bleiben verfügbar. Das Löschen eines vollständigen Teilbaums verlangt
eine Bestätigung; Verschieben benötigt kein zusätzliches Formular. Sichtbare
Ziehgriffe entfallen, der Tastaturauslöser bleibt zugänglich.

Die Gliederungsbreite lässt sich wie eine Explorer-Seitenleiste ziehen, mit den
Pfeil-/Pos1-/Ende-Tasten am Trenner einstellen und per Doppelklick zurücksetzen.
Die Einstellung bleibt beim Wiederöffnen bestehen. Auf schmalen Bildschirmen
steht die Gliederung in voller Breite oberhalb des Dokuments.

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

Gruppentitel beginnen auf derselben horizontalen Position wie Positionstexte und
verwenden je Ebene 20/18/17/16/15 px. Neue Kurztexte sind fett; Enter beginnt eine
normal gesetzte Beschreibung. Gruppenbeschreibungen bleiben im nativen Titeltext
erhalten, auch beim Umbenennen im Baum. Neue Positionen gleichen den Kurztext mit
dem ersten Absatz ab. Unabhängige importierte Kurz- und Langtexte behalten Inhalt
und Formatierung. Absätze haben sechs Pixel Abstand; Positionszeilen bleiben kompakt.

### Frühere Positionen wiederverwenden

Eine durchsuchbare Vervollständigung findet frühere Positionen samt Beschreibung
und Einheit. Neue Mengen und Preise beginnen bei null. sortsys indiziert native
kaufmännische Dokumente und Projektdateien automatisch, aktualisiert geänderte
Quellen, entfernt doppelte Vorschläge und durchsucht Kurz- und Langtexte. Der
mandantenbezogene Metadatenindex ersetzt keine Originaldatei. Eigenständige
Editoren verwenden eine abgegrenzte IndexedDB-Historie; Host-Anwendungen können
`searchPositions` und `positionLibraryScope` bereitstellen. Eingefügt wird direkt
unter der zuletzt bearbeiteten Position innerhalb derselben Gruppe, auch nach
einem Klick auf leere Fläche oder dem Öffnen der Suche.

### Vertrautes Menüband

Das einklappbare Office-artige Menüband ordnet Befehle unter Start, Einfügen und
Ansicht. Arbeitsabläufe und Bearbeitung stehen links, Anwesenheit, Suche und
Drucken rechts. Die Reiter unterstützen Pfeil-/Pos1-/Ende-Navigation. Eine
kompakte Titelleiste zeigt Dokumenttyp und Dateiname zusammen; der Zoom steht in
der Fußleiste. Sichtbare Aktionsbeschriftungen nutzen ausgewogene Zweizeiler mit
unterem Abstand. Zugängliche Namen und Tastenkürzel behalten den vollen Namen.
Zusätzliche Gruppenuntertitel und Hover-Tooltips entfallen. Unter Ansicht steht
eine Tastenkürzelübersicht; Formatierungszustände bleiben zugänglich.
Die frühere Dateidetail-Fußleiste entfällt, eingebettete Dateien liegen unter Einfügen.

## Automatisch speichern und gemeinsam arbeiten

Automatisches Speichern übernimmt fokussierte Eingaben nach einer kurzen
Schreibpause, prüft vor dem Schreiben, arbeitet Anfragen nacheinander ab und
wiederholt fehlgeschlagene Versuche. IndexedDB hält unbestätigtes XML und
unvollständige Feldeingaben für Benutzer und Dokument zur Wiederherstellung vor.
Ungültige Eingaben warten auf Korrektur, statt endlos erneut gesendet zu werden.
Nur Probleme erzeugen Statusmeldungen; erfolgreiche Speicherung und Schema-Prüfung
bleiben unaufdringlich. Einheiten beachten das GAEB-Limit von vier Zeichen.
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
nicht nötig. Prüfpunkte begrenzen die Wiederholungskosten; nach Verbindungsverlust
holt ein Listener Änderungen aus dem Protokoll nach. Pro aktivem Mandanten und
API-Instanz besteht eine zusätzliche Listener-Verbindung, die nach einer Minute
Inaktivität schließt. Cursoränderungen werden alle 100 ms zusammengefasst,
Berechtigungen und Gültigkeit alle 30 Sekunden geprüft. Kurzlebige,
dokumentbezogene Tickets stehen in der ersten Socket-Nachricht, nie in der URL.
Sitzungs- und Projektzugriff werden während der Verbindung erneut geprüft.

Native XML-Stände verwenden einen vorsichtigen Drei-Wege-Abgleich, getrennt vom
gemeinsamen Feldtext. Unabhängige Felder werden zusammengeführt, reproduzierbare
Summen neu berechnet. Widersprüchliche Preise oder überlappende Struktur- und
Formatänderungen erhalten die lokale Wiederherstellungskopie und melden einen
Konflikt. Mengen und Preise sind keine Zeichen-CRDTs. Fremde Änderungen entfernen
Rückgängig-Schnappschüsse der Gesamtdatei, damit Rückgängig keine fremde Arbeit
verwirft. Nach Wiederverbindung wird das Dokument vor dem Fortsetzen aktualisiert.

## Aufmaß mit mehreren Ansätzen

X31 unterstützt mehrere Maßansätze je Position mit Ort, Beschreibung, Anzahl und
Dimensionen. Längen/Fugen, Rechteckflächen, drei Dimensionen, Dreiecke, Trapeze,
anpassbare Bogen-/Formfaktoren und freie Rechenausdrücke verwenden dieselbe
Canvas-Typografie und Tastaturbedienung. Dezimalfelder verwenden das Gebietsschema
des Dokuments und mindestens drei Nachkommastellen; zusätzliche Eingabegenauigkeit
bleibt erhalten. Der Ausdrucksparser rechnet begrenzt mit exakten rationalen Zahlen,
akzeptiert Dezimalkomma/-punkt und ×/x/* und führt kein JavaScript aus.

Für Öffnungsabzüge lässt sich ausdrücklich eine Grenze von 2,50 m² oder 0,50 m²
je Öffnung aktivieren. Geprüft wird die einzelne Fläche vor ihrer Vervielfachung.
Andere Zu- und Abzüge bleiben unberührt. Die Regel wird je Ansatz gewählt und
nicht aus dem Gewerk vermutet. Der Faktor der Bogenvorlage ist editierbar und
behauptet keine universelle Kreissegmentformel.

Jeder unterstützte Ansatz schreibt eine ausführbare native REB-FN91-Zeile und
aktualisiert die X31-Menge. Form, vollständige Beschreibung und Ortsbezeichnung
bleiben in versionierten XML-Kommentaren erhalten, ohne das offizielle Schema
zu ändern; native Adressen bleiben stabil. Vorhandene FN91-Zeilen sind als
Formeln bearbeitbar. Reine Mengendateien behalten ein ausdrücklich ausgewiesenes
übernommenes Aufmaß; nicht unterstützte REB-Zeilen behalten Bytes und Basismenge.
Inkonsistente extern bearbeitete Summen oder Metadaten stoppen unterstützte
Änderungen. Unabhängige Zeilenänderungen werden vor der Summenberechnung vereinigt,
widersprüchliche fachliche Eingaben bleiben geschützt. REB 2009 summiert exakte
Ansätze vor der Mengenrundung; REB 1979 rundet einzelne Ansätze. Die Ausgabe 2023
erhält eingebettete PDFs/Bilder und erlaubt Hinzufügen sowie Herunterladen.
Das native Zeilenformat folgt [GAEB 3.3, §7](https://www.gaeb.de/wp-content/uploads/2023/09/Fachdokumentation_GAEB-DA-XML_3.3_2023-01.pdf).

Strg/Cmd+Enter fügt einen Ansatz hinzu, Strg/Cmd+Umschalt+Enter dupliziert ihn,
Strg/Cmd+Alt+Rücktaste löscht den ausgewählten Ansatz. Tab/Umschalt+Tab und Enter
wechseln zwischen Feldern. Neue Zeilen folgen direkt dem ausgewählten Ansatz.

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

## Vom Angebot zum Auftrag

Die Webapp trennt Angebote von Projekten. Ein Hauptangebot beginnt mit einer X83
oder einem direkt erfassten Leistungsumfang und wird in der verknüpften X84
kalkuliert. Abgabe und Annahme halten feste native Dokumentstände fest. Ein
angenommenes Hauptangebot kann genau ein neues Projekt erzeugen; sein Auftragswert
geht einmal in die Projektkostenübersicht ein. Weitere Angebote dieses Projekts
sind Nachträge. Angenommene Nachträge einschließlich Minderungen ändern den Auftragswert.

Jeder eingebundene Editor öffnet im Vollbilddialog, auch auf schmalen Bildschirmen.
Die Angebotsliste öffnet direkt diesen Dialog. Im Menüband lassen sich eine X83
öffnen, die verknüpfte X84-Kalkulation beginnen sowie Abgabe und Annahme erfassen.
Herunterladen und Vorgangsverlauf haben eigene Schaltflächen. Kontextabhängige
Aktionen öffnen den Leistungsumfang oder kehren zur Kalkulation zurück; das
aktuelle Dokument steht nie selbst als Wechselziel zur Auswahl.

Hintergrundseite, Filter und geladene Zeilen bleiben beim Öffnen und Schließen
erhalten. Ein offener kaufmännischer Vorgang trägt die Adresse `/gaeb/:caseId`.
Neuladen und Direktlinks öffnen den Dialog wieder; Zurück schließt über die
Speicherlogik, Vorwärts öffnet erneut. Beim Schließen wird die vorherige Adresse
ohne Austausch der Hintergrundseite wiederhergestellt. Derselbe Dialog und
Fokusbereich bleiben beim Laden, Anlegen und Wechseln nativer Dokumente bestehen.
Eine separate Angebotsdetailseite oder ein Inline-Editor entfällt. Die Anlage
verwendet die gemeinsame interaktive Kundensuche.

Verwaltung → Organisation hält Unternehmensname und Anschrift für neue Angebote
und Preisanfragen bereit. Reiter trennen Unternehmensdaten, Rechnungsnummern,
Dokumentvorlagen, Logo, Personalvorgaben und LLM-Nutzung. Formularentwürfe bleiben
beim Reiterwechsel erhalten. Native Anschriften sind bearbeitbar; das Aktualisieren
einer Kalkulation erhält die bereits eingetragene Anschrift.

Rechnungsnummern können global fortlaufend, mit getrenntem oder kompaktem Datum
sowie projektlokal oder projektbezogen global fortlaufend vergeben werden.
Eine exakte dezimale Startnummer und fünf aufeinanderfolgende Vorschaunummern
zeigen das Ergebnis. Der Projektteil verwendet die letzten acht Dezimalziffern
der decodierten öffentlichen Projekt-ID mit führenden Nullen. Dieser feste
Ausschnitt ist nicht kollisionsfrei; die Rechnungsvergabe erzwingt die Eindeutigkeit
zusätzlich. Die Zähler werden bei Ausstellung transaktional vergeben.

Unter **Auftrag & Leistungen** stehen angenommenes Angebot, Kunden-X86,
X87-Bestätigung, Nachträge, X31-Aufmaße und Nachunternehmerpakete zusammen.
Ein eingegangener Auftrag wird vor seiner Bestätigung mit dem Angebot verglichen.
Bestehende Projekte können ihren ursprünglichen X86-Auftrag einmal übernehmen;
historische Finanzbuchungen bleiben ohne erneute Auftragswertbuchung erhalten.

Aufmaße verweisen auf einen angenommenen Auftrag oder Nachtrag. Vertragsmengen
bleiben von aufgemessenen Mengen getrennt. Weitervergaben erstellen aus gewählten
vollständigen Positionen eine neue X83 ohne Verkaufspreise und undurchsichtige
Herstellerdaten. Mehrere Nachunternehmer-X84 können verglichen werden; das gewählte
Angebot wird zum X86-Auftrag. Bereits vergebene Positionen können unter demselben
Auftrag nicht doppelt vergeben werden. X87-Dateien des Nachunternehmers halten die
Bestätigung fest. Abweichende Mengen und fehlende Angebotspositionen müssen vor
Vergabe geklärt werden.

Quelldateien und Verweise auf deren Stände bleiben erhalten. Ableitungen verwenden
GAEB 3.3. Nicht unterstützte Preis- oder Positionsregeln stoppen die Ableitung
ausdrücklich, statt Daten zu verlieren. Der Ablauf verwendet derzeit EUR; die
native Bearbeitung erhält andere Währungen und Spezialdaten. X86→X87 erhält den
vollständigen Auftrag samt Preisregeln und Beteiligten. Diese Abläufe erfassen
Abgabe, Annahme und Vergabe. Das Versenden an Kunden oder Lieferanten bleibt eine
ausdrückliche Aktion außerhalb des Editors. `projects.create` bleibt für vorhandene
API-Clients verfügbar; neue Produktoberflächen beginnen beim Angebot.

## Tastaturbedienung

Tab und Umschalt+Tab wechseln in Lesereihenfolge durch bearbeitbare Felder und
einzelne Absätze. Der Zielabsatz wird vollständig markiert. Am ersten und letzten
Feld geht der Fokus zu den umgebenden Bedienelementen zurück. Enter wechselt in
einzeiligen Feldern weiter und fügt in Beschreibungen einen Absatz ein.
Umschalt+Enter geht zum vorherigen einzeiligen Feld.

Benachbarte Absätze und formatierte Textteile bilden einen gemeinsamen Textpuffer.
Tabellenzellen, Listeneinträge und geschützte Strukturen behalten eigene Grenzen.
Strg/Cmd+A markiert den aktiven Puffer; Strg/Cmd+C, X und V verwenden die
Zwischenablage. Kopieren funktioniert auch schreibgeschützt. Absatzumbrüche bleiben
beim Kopieren erhalten; nicht ausgewähltes XML, Formatierungen und Erweiterungen
bleiben im Dokument.

| Aktion | Windows/Linux | macOS |
| --- | --- | --- |
| Wortweise bewegen | Strg+Links/Rechts | Option+Links/Rechts |
| Anfang/Ende der sichtbaren Zeile | Pos1/Ende | Cmd+Links/Rechts oder Pos1/Ende |
| Anfang/Ende des Textpuffers | Strg+Pos1/Ende | Cmd+Auf/Ab |
| Absatzweise bewegen | Strg+Auf/Ab | Option+Auf/Ab |
| Auswahl erweitern | Navigationstaste mit Umschalt | Navigationstaste mit Umschalt |
| Wort löschen | Strg+Rücktaste/Entf | Option+Rücktaste/Entf |
| Bis zum sichtbaren Zeilenrand löschen | — | Cmd+Rücktaste/Entf |
| Fett / kursiv / unterstrichen | Strg+B/I/U | Cmd+B/I/U |
| Rückgängig / Wiederholen | Strg+Z / Strg+Y oder Strg+Umschalt+Z | Cmd+Z / Cmd+Umschalt+Z |
| Neue Position | Strg+Enter | Cmd+Enter |
| Neue Gruppe | Strg+Umschalt+Enter | Cmd+Umschalt+Enter |
| Ausgewählten Eintrag löschen | Strg+Alt+Rücktaste | Cmd+Option+Rücktaste |
| Druck-PDF mit Typst erzeugen | Strg+P | Cmd+P |

Auf/Ab und Bild-auf/Bild-ab folgen den gezeichneten Canvas-Zeilen und erhalten die
horizontale Cursorposition. Bewegung und Löschen beachten Graphemgruppen, auch
kombinierte Akzente und verbundene Emoji. Umschalt-Auswahl behält beim
Richtungswechsel ihren ursprünglichen Anker. Bei gehaltenen Navigationstasten
bleibt der Cursor sichtbar; nach Bewegung beginnt die Blinkpause neu. Markierter
Text verwendet blauen Hintergrund (`#0000ff`) und weiße Zeichen (`#ffffff`),
einschließlich Formatierung und Unterstreichung.

## Druckvorlagen und Ansichtseinstellungen

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

Feldanzeige, Gliederungssichtbarkeit und -breite, eingeklapptes Menüband sowie
Zoom- und Breitenanpassung werden pro angemeldetem Benutzer serverseitig gespeichert.
Schließen überträgt ausstehende Einstellungen. Der eigenständige Editor verwendet
ersatzweise lokale Vorgaben. Ladeanzeigen für Angebote und native Dokumente stehen
mittig im Vollbilddialog, ohne dessen Fokusbereich auszutauschen.

## Native Abrechnung und Beschaffung

X85-Nebenangebote haben eigene Abgabe- und Annahmestände und behalten den Bezug zum
Hauptangebot. Angenommene Nebenangebote können ebenfalls Projektauftrag werden.
Projektformulare erstellen X31, X52, X93 und X89 aus einem angenommenen Auftrag.
X52-Kostenbestandteile zeigen Kennung, Menge, Einheit, optional Leistung und Wert
im Canvas-Editor.

X93-Preisanfragen enthalten keine Verkaufspreise. Empfangene X94-Angebote sind
unveränderlich; das gewählte Angebot wird bis zur Vergabe als native X96-Bestellung
bearbeitet. X97-Lieferantenbestätigungen bleiben unveränderlich. Handelsdateien
verwenden ihre native flache `OrderItem`-Struktur sowie native Preise und Preisbasen.
Der Editor erfindet dafür keine LV-Gruppen.

X89-Entwürfe zeigen Beteiligte, Rechnungsdatum, Leistungszeitraum und Steuernummer.
Ausstellung vergibt serverseitig die konfigurierte Rechnungsnummer, hält einen
nativen Stand fest und bucht den Nettobetrag einmal. Zahlungen sind separate
Datensätze; Teil-/Vollzahlungsstände folgen dem exakten offenen Bruttobetrag.
Leistungsbezogene und pauschale Abschlagsrechnungen verwenden periodische
Abrechnung. Eine Schlussrechnung setzt ausgestellte Abschlagsrechnungen voraus
und zieht diese unabhängig vom Zahlungsstand ab. Eine gewöhnliche Rechnung steht
nur für Aufträge ohne Abschlagsrechnungen bereit. Nicht unterstützte Abrechnungs-
oder Preisregeln bleiben einsehbar und gelangen nicht unbemerkt in diese Abläufe.

Die Regressionsbeispiele unter `scripts/fixtures/native-seed` entstehen mit den
tatsächlichen Seed-Konstruktoren der API. Browserprüfungen validieren alle
offiziellen Schemas und prüfen native Bearbeitung, Ableitung, Festkomma-Umsatzsteuer
und Abrechnung.

## Ältere Angebotsaufforderungen öffnen

Neben X83 kann die Schaltfläche für Leistungsanfragen D83 (GAEB 90) und P83
(GAEB 2000) öffnen. Der Client erkennt den Inhalt und überführt Festbreitenmengen,
OZ-Strukturen und GAEB-2000-RTF-Texte in eine schema-geprüfte X83. Die vollständigen
Originalbytes bleiben in einem reservierten XML-Kommentar erhalten. P83-Texte
werden nach bestem Bemühen übernommen; nicht unterstützte besondere
D83-Positionsarten werden ausdrücklich abgelehnt, statt als gewöhnliche
bepreiste Positionen zu erscheinen. Fiktive Regressionsbeispiele stehen unter
`scripts/fixtures/legacy/`.

## Prüfungen

```sh
bun run typecheck
bun test
bun run build
bunx playwright install chromium
bun run test:browser
```

`test:browser` baut vor der Testsuite die Aufmaß-Beispielseite. Normale Builds
enthalten diese fiktiven Prüfdokumente nicht.

Produktionsbrowser-Tests decken bytegenauen XML-Erhalt, alle unterstützten Phasen,
eingebettete X31-Daten, kontinuierliche Darstellung, verankerten Gestenzoom,
automatisches Speichern und Wiederherstellung ab. Die Browser-Suite der
Host-Anwendung prüft zwei gleichzeitige Editoren, gemeinsame Summen, Anwesenheit
und Wiederverbindung. API-Tests prüfen zusätzlich echte S3-/PostgreSQL-Schreibzugriffe,
begrenzte Live-Tickets, Socket-Bereinigung, Revisionen, Projekttrennung und Anmeldung.

Herkunft der Originalschemas und Archivprüfsummen: [GAEB-Schemas](vendor/gaeb/README.md).
