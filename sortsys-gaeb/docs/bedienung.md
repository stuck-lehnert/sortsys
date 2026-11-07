# Mit dem GAEB-Editor arbeiten

Ein Klick auf ein Angebot öffnet den Editor im Vollbilddialog, auch auf schmalen
Bildschirmen. Die Angebotsübersicht bleibt im Hintergrund geöffnet. Im Menüband
lassen sich eine X83 öffnen, die verknüpfte X84-Kalkulation beginnen sowie Abgabe und Annahme erfassen.
Die [Geschäftsabläufe](ablaeufe.md) erklären die einzelnen Schritte.
Herunterladen und Vorgangsverlauf haben eigene Schaltflächen. Kontextabhängige
Aktionen öffnen den Leistungsumfang oder kehren zur Kalkulation zurück; das
aktuelle Dokument steht nie selbst als Wechselziel zur Auswahl.

Hintergrundseite, Filter und geladene Zeilen bleiben beim Öffnen und Schließen
erhalten. Ein offener kaufmännischer Vorgang trägt die Adresse `/gaeb/:caseId`.
Neuladen und Direktlinks öffnen den Dialog wieder; Zurück schließt über die
Speicherlogik, Vorwärts öffnet erneut. Beim Schließen wird die vorherige Adresse
ohne Austausch der Hintergrundseite wiederhergestellt.
Beim Anlegen eines Angebots wird der Kunde über die interaktive Suche gewählt.

## Text bearbeiten

Bearbeitbare Felder haben dezente blaue Hintergründe und gestrichelte, rechteckige
Rahmen. Bei Fokus oder wenn der Mauszeiger über einem Feld steht, wird der Rahmen
deutlicher. Der Mauszeiger kennzeichnet die Eingabe; die Feldanzeige lässt sich
abschalten. Die Textauswahl folgt dem Zeiger über die ursprüngliche Trefferfläche
hinaus, behält ihre Richtung bei und scrollt an Fensterrändern. Beim Fokussieren
eines Feldes bleibt der gewählte Zoom erhalten.
Gedruckt werden keine Eingabemarkierungen.

Doppelklick markiert ein Wort, Dreifachklick den vollständigen Absatz einschließlich
umgebrochener Zeilen. Bereits beim Drücken der Maustaste gilt die endgültige
Auswahl. Ziehen erweitert sie wort- oder absatzweise, ohne kurz zum Cursor
zusammenzufallen. Ein Klick auf leeres Papier, Arbeitsfläche oder Gliederung
entfernt Cursor und Auswahl, übernimmt offene Eingaben und hält den Tastaturfokus
im Vollbilddialog. Formatierungsbefehle erhalten die Auswahl.

## Gliederung

Ausgewählte Gruppen nehmen neue Einträge auf; bei ausgewählten Positionen gilt
deren übergeordnete Gruppe. Neue leere Gruppen werden direkt im Baum benannt.
F2 oder das Eintragsmenü benennt um, Enter oder Fokusverlust übernimmt, Escape
bricht ab. Ein Klick auf Gruppennamen klappt sie ein oder aus; die Werkzeugleiste
kann alle einklappen. Kontext- und Zeilenmenüs bieten dieselben Aktionen für Maus,
Tastatur und Berührung. Beim Anlegen einer Gruppe bleiben vorhandene Positionen
an ihrem Ort; eingeklappte übergeordnete Gruppen werden geöffnet. Gruppen dürfen
unterschiedlich tief verschachtelt sein.

Zeilen lassen sich zwischen Positionen und Gruppen einsortieren, auf Gruppen
ablegen oder über „Gesamtes Dokument“ auf die oberste Ebene verschieben. Auch der
direkte Wechsel in eine beliebige übergeordnete Gruppe ist möglich. Eingeklappte
Gruppen öffnen sich beim längeren Darüberhalten; Einfügelinien und hervorgehobene
Gruppen zeigen das Ziel. Eine Gruppe wird mit allen untergeordneten Einträgen
verschoben. Das geht auch per Tastatur; Alt+Auf/Ab ändert die Reihenfolge.
Das Löschen eines vollständigen Teilbaums verlangt eine Bestätigung.
Verschoben wird direkt in der Gliederung. Die ganze Zeile lässt sich ziehen;
ein Tastaturauslöser ist ebenfalls vorhanden.

Die Gliederungsbreite lässt sich wie eine Explorer-Seitenleiste ziehen, mit den
Pfeil-/Pos1-/Ende-Tasten am Trenner einstellen und per Doppelklick zurücksetzen.
Die Einstellung bleibt beim Wiederöffnen bestehen. Auf schmalen Bildschirmen
steht die Gliederung in voller Breite oberhalb des Dokuments.

Neue Kurztexte sind fett; Enter beginnt eine
normal gesetzte Beschreibung. Gruppenbeschreibungen bleiben im nativen Titeltext
erhalten, auch beim Umbenennen im Baum. Neue Positionen gleichen den Kurztext mit
dem ersten Absatz ab. Unabhängige importierte Kurz- und Langtexte behalten Inhalt
und Formatierung.

## Positionen wiederverwenden

Eine durchsuchbare Vervollständigung findet frühere Positionen samt Beschreibung
und Einheit. Neue Mengen und Preise beginnen bei null. sortsys indiziert native
kaufmännische Dokumente und Projektdateien automatisch, aktualisiert geänderte
Quellen, entfernt doppelte Vorschläge und durchsucht Kurz- und Langtexte.
Eingefügt wird direkt unter der zuletzt bearbeiteten Position innerhalb derselben Gruppe, auch nach
einem Klick auf leere Fläche oder dem Öffnen der Suche.

## Menüband und Ansicht

Das einklappbare Office-artige Menüband ordnet Befehle unter Start, Einfügen und
Ansicht. Arbeitsabläufe und Bearbeitung stehen links, Anwesenheit, Suche und
Drucken rechts. Die Reiter unterstützen Pfeil-/Pos1-/Ende-Navigation. Eine
kompakte Titelleiste zeigt Dokumenttyp und Dateiname zusammen; der Zoom steht in
der Fußleiste. Unter Ansicht steht eine Tastenkürzelübersicht.
Eingebettete Dateien liegen unter Einfügen.

Feldanzeige, Gliederungssichtbarkeit und -breite, eingeklapptes Menüband sowie
Zoom- und Breitenanpassung werden pro angemeldetem Benutzer serverseitig gespeichert.
Schließen überträgt ausstehende Einstellungen. Der eigenständige Editor verwendet
ersatzweise lokale Vorgaben.

Trackpad-Gesten, Strg/Cmd+Mausrad und die Zahleneingabe ändern den Zoom.
Die Breitenanpassung folgt der Fenstergröße; Gesten behalten den Punkt unter
dem Zeiger als Bezugspunkt. Drucken und Strg/Cmd+P erzeugen ein PDF mit Seiten;
die Editoransicht selbst hat keine Seitenumbrüche.

## Aufmaß erfassen

X31 unterstützt mehrere Maßansätze je Position mit Ort, Beschreibung, Anzahl und
Dimensionen. Längen/Fugen, Rechteckflächen, drei Dimensionen, Dreiecke, Trapeze,
anpassbare Bogen-/Formfaktoren und freie Rechenausdrücke verwenden dieselbe
Canvas-Typografie und Tastaturbedienung. Dezimalfelder verwenden das Gebietsschema
des Dokuments und mindestens drei Nachkommastellen; zusätzliche Eingabegenauigkeit
bleibt erhalten.

Für Öffnungsabzüge lässt sich ausdrücklich eine Grenze von 2,50 m² oder 0,50 m²
je Öffnung aktivieren. Geprüft wird die einzelne Fläche vor ihrer Vervielfachung.
Andere Zu- und Abzüge bleiben unberührt. Die Regel wird je Ansatz gewählt und
nicht aus dem Gewerk vermutet. Der Faktor der Bogenvorlage ist editierbar und
behauptet keine universelle Kreissegmentformel.

Strg/Cmd+Enter fügt einen Ansatz hinzu, Strg/Cmd+Umschalt+Enter dupliziert ihn,
Strg/Cmd+Alt+Rücktaste löscht den ausgewählten Ansatz. Tab/Umschalt+Tab und Enter
wechseln zwischen Feldern. Neue Zeilen folgen direkt dem ausgewählten Ansatz.

Zwischenüberschriften gliedern mehrere Ansätze innerhalb einer Position und
lassen sich im Menüband hinzufügen. Strg+Q und Strg+W wechseln zur vorherigen
beziehungsweise nächsten Berechnungsart. Auf macOS wird dafür die Control-Taste
verwendet. Die Reihenfolge der Berechnungsarten richtet sich nach der Einheit.

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
