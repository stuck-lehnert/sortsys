# Aktionen passend zur Datenfreigabe anzeigen

Produktkatalog, Kunden, Ansprechpartner, Lieferanten, Preisaufzeichnungen,
Personalprofile, Werkzeuge, Projektgrunddaten, Tages- und Regieberichte,
Lieferscheine und Client-Skripte verwenden ihre verifizierten Freigaben auch für
die Anzeige von Menüs und Schaltflächen. Ein Benutzer mit Leserechten sieht die
zugehörigen Ansichten. Mit einer Bearbeitungsfreigabe stehen die passenden
Änderungsaktionen zur Verfügung. Das Anlegen neuer Einträge wird gesondert
geprüft.

Eine bisherige Administratorrolle öffnet diese Inhaltsaktionen nicht pauschal.
Sie bleibt für die vollständige Organisationsverwaltung und die technischen
Anmelderollen maßgeblich. Ein bereichsgebundenes Verwaltungsrecht öffnet daneben
die begrenzte Ansicht **Datenfreigaben**. Ein eigenes Verwaltungsrecht für
persönliche Einstellungen reicht dafür nicht aus. Die Inhaltsfreigabe benötigt
weiterhin eine gültige signierte Regel.
Der Browser bindet diese Regel an die bestätigte Identität des angemeldeten
Kontos; eine andere Benutzerkennung aus einer Antwort genügt nicht.

Der KI-Assistent benötigt Lesen, Anlegen und Bearbeiten im eigenen
Assistentenbereich. Die persönliche Verlaufsfreigabe öffnet damit auch die
Assistentenfunktionen. Sie vergibt keinen Zugriff auf den Produktkatalog oder
interne Preise. Ein Entzug beendet laufende Modellanfragen auch dann, wenn die
Verwaltung mit einer anderen API-Instanz verbunden ist.

Die Menüanzeige liest dafür nur öffentliche technische Metadaten und signierte
Nachweise. Sie fordert weder Inhaltsschlüssel noch Produkttexte, Preise oder
Dokumente an. Die Datenadapter und die API prüfen jede tatsächliche Aktion
zusätzlich. Eine sichtbare Schaltfläche vergibt kein neues Recht.

[Vermerke](verschluesselte-vermerke.md) richten sich nach dem jeweiligen
Projekt, Werkzeug, Kunden- oder Kontaktkatalog. Auch ihre Schaltflächen trennen
Anlegen, Bearbeiten und Löschen. Ein Änderungsrecht für ein anderes Projekt
öffnet keine Vermerkaktion.

Menü, Dateiübersicht und Datenadapter verwenden dieselben Prüfbausteine. Beim
Laden der Regeln werden Mandant, Datenformat und Signatur gegen den im Konto
bestätigten Schlüssel geprüft. Ein Kontowechsel während der Anfrage oder der
Signaturprüfung verwirft die Antwort. Erst danach werden die Regeln für die
jeweiligen Benutzer ausgewertet. Ausdrückliche Verbote haben überall Vorrang;
ein Bearbeitungsrecht erzeugt dabei nicht automatisch ein Leserecht. Die
Menüanzeige verlangt Lesen zusätzlich, bevor sie eine Inhaltsaktion anbietet.
Zertifizierte Anlagenachweise werden weiterhin gesondert geprüft.

Auch Freigabeänderungen haben einen gemeinsamen Speicherweg. Er signiert die
neuen Regeln und verlangt anschließend genau deren signierten Stand beim
Zurücklesen. Eine erfolgreiche HTTP-Antwort allein genügt nicht. Geht die
Antwort nach dem Speichern verloren, kann derselbe Nachweis den Abschluss
bestätigen. Ein fremder oder inzwischen ersetzter Stand wird nicht als eigene
Änderung bestätigt. Das gilt für neue Freigaben ebenso wie für deren Entzug.

## Angebote und Projekte unabhängig anlegen

**Angebot erstellen** verwendet die eigene Freigabe für neue Angebote und
Aufträge. Dafür ist kein vorhandenes Projekt nötig. Das Recht, ein bestehendes
Projekt zu bearbeiten, erlaubt umgekehrt keine neue Angebotsanlage. Die
Freigaben **Neue Projekte anlegen** und **Neue Angebote und Aufträge anlegen**
bleiben unabhängig.

Ein neu angelegtes Projekt oder Angebot erhält seine Zugriffe über den
zertifizierten Anlagenachweis. Die Menüanzeige prüft auch diesen Nachweis. Wird
die Anlageberechtigung später entzogen, bleiben bereits vergebene Zugriffe auf
vorhandene Projekte erhalten.

Vorbereitete Schlüsselbereiche allein erlauben noch keine neue Anlage. Beim
ersten Speichern des eigentlichen Projekt-, Vorgangs-, Werkzeug- oder
Buchungsdatensatzes prüft die API das aktuelle Anlegerecht erneut. Das gilt auch
für einen Wiederholungsversuch nach einer Unterbrechung und für zuvor
hochgeladene, noch unveröffentlichte Chiffrate. Die Prüfung und Veröffentlichung
verwenden dieselbe Transaktion. Die Übernahme eines Backups bei der Ersteinrichtung
hat einen eigenen Nachweis der Mandantenautorität; nach abgeschlossener Einrichtung
lässt sich dieser Weg nicht mehr verwenden.

Bei Client-Skripten hat **Neu** eine eigene Anlagefreigabe. Leserechte und das
Recht, ein Skript anzulegen, erlauben keine spätere Codeänderung oder Löschung.
Die Übersicht durchsucht Namen und Beschreibungen im Browser; der Code gehört
nicht zur Listenantwort. Skripte bleiben in ihrem eigenen verschlüsselten
Organisationsbereich. Nach einem Rechteentzug wird der Schlüssel für künftige
Änderungen gewechselt. Bereits gelesener Code lässt sich damit nicht
zurückholen.

Auf einer Projektseite richten sich Bearbeiten, Abschließen, Fortsetzen und
Löschen nach der Freigabe genau dieses Projekts. Eine Bearbeitungsfreigabe für
ein anderes Projekt genügt nicht. Der Reiter **Anhänge** benötigt zusätzlich
Lesezugriff auf die Projektdateien. Die Dokumentensuche erscheint bei einer
entsprechenden Dateifreigabe.

## Werkzeuge ausgeben

**Werkzeuge einbuchen** verwendet im Seitenmenü und in der Detailansicht
dieselbe Prüfung. Sie verlangt das Recht für neue Werkzeugbuchungen sowie
Schreibzugriff auf Stammdaten und derzeit Lesezugriff auf die Kosten desselben
Werkzeugs. Eine Schreibfreigabe für Werkzeug A und eine Preisfreigabe für
Werkzeug B reichen dafür nicht aus. Ohne das Anlegerecht bleibt die Aktion
ausgeblendet, auch wenn bereits vorhandene Buchungen bearbeitet werden dürfen.

Eine Rückgabe benötigt das Anlegerecht nicht. Die ursprüngliche Buchung bleibt
auch nach dessen Entzug zugänglich, solange ihre Einzelfreigaben bestehen.
**Werkzeug erstellen** benötigt ebenfalls eine eigene Anlagefreigabe und den
gemeinsamen Nummernindex; das Änderungsrecht für ein vorhandenes Werkzeug
erlaubt keine neue Anlage.

## Laufende Aktualisierung

Änderungshinweise über den WebSocket verwerfen die bisherige Menüfreigabe.
Während der Prüfung des neuen Stands bleiben die betroffenen Aktionen gesperrt.
Das funktioniert auch, wenn Verwaltung und Benutzer an unterschiedlichen
API-Instanzen verbunden sind. Ein Kontowechsel verwirft laufende Abfragen; eine
verspätete Antwort kann die alten Aktionen nicht wieder einschalten. Bei einem
Ladefehler lässt sich die Prüfung mit **Erneut versuchen** wiederholen.

Die technischen Verwaltungsrollen und die Inhaltsfreigaben bleiben getrennt. Der
vollständige Funktionsabgleich muss weiterhin die einzelnen Aktionen der
Dokumenteditoren und ihre Verweise auf andere Fachbereiche prüfen.

## Offene Dialoge bei Rechteverlust

Die gemeinsame Dialogverwaltung bindet Formulare und Detailansichten an die
aktuelle Datensitzung. Ein Kontowechsel oder ein Rechteverlust beendet diese
Sitzung. Offene Dialoge entfernen dann ihre geladenen Werte. Ein zurückgehaltener
Dialog-Handle kann weder einen alten Dialog erneut öffnen noch dessen Adresse
ändern. Das gilt auch für verzögerte Ersatzdialoge und die Weiterleitung nach
einem Formularabschluss. Zusätzliche Freigaben im laufenden Änderungsstrom
erhalten die Sitzung und bereits eingegebene Formularwerte. Nach einer
unterbrochenen Verbindung wird ein abweichender Zugriffsstand vorsorglich neu
aufgebaut.

Für Dokumentdialoge wird dabei die aufrufende Seite wiederhergestellt. Bei
verschachtelten Dialogen werden die betroffenen Adresseneinträge nacheinander
geschlossen; eine alte Rückfrage zum Speichern darf den Rechteentzug nicht
aufhalten. Die Datenadapter und die API prüfen Schreibvorgänge weiterhin
unabhängig von der Dialoganzeige.

Browsertests prüfen offene Werte, alte Formularaufrufe, verspätete Antworten und
verschachtelte Dokumentadressen mit der tatsächlichen Dialogverwaltung. Der
native Mehrinstanztest entzieht einem Mitarbeiter den Katalogzugriff, während
sein Produktformular mit einem ungespeicherten Entwurf geöffnet ist. Formular
und Kataloginhalte müssen daraufhin aus seiner Oberfläche verschwinden.

## Freigabevorlagen für Projekte

Unter **Berechtigungen verwalten → Projektzugriff** lässt sich für das
gewählte Benutzerkonto eine **Freigabevorlage** auswählen. **Projekt und
Anhänge lesen** umfasst die Projektgrunddaten und Dateien. Mit
**Baustellendokumentation** kann das Team Tages- und Regieberichte bearbeiten
sowie Dateien lesen und hochladen. **Bauleitung** umfasst außerdem die
Einsatzplanung, Lieferscheine und die Regiestunden.

**Einzelrechte ergänzen** trägt die Vorlage in die Felder des ausgewählten
Projekts ein. Dort lassen sich die Einträge prüfen oder ändern. Die neue
Freigabe wird mit **Projektzugriff speichern** wirksam. Rechte für Kosten,
Rechnungen, Löschung und Freigabeverwaltung werden separat vergeben.

## Bautagesberichte und Arbeitskosten

Ein Projekt kann Bautagesberichte und Arbeitszeiten freigeben, ohne seine
internen Arbeitskosten offenzulegen. Beide Bereiche lassen sich in der
Projektfreigabe getrennt vergeben. Das Erstellen eines Berichts verwendet ein
Anlagerecht; ein Leserecht allein öffnet keine Bearbeitungsaktion. Die
Detailansicht prüft das konkrete Projekt, bevor sie Änderungen oder
Löschaktionen anbietet.

Die Freigabenansicht liest die Projektbereiche aus einem gemeinsam geprüften
Regelstand. Unveränderte Bereiche bleiben beim Speichern erhalten. Ein Fehler
nach einer bereits bestätigten Teilfreigabe setzt deren Anzeige nicht auf den
alten Stand zurück.

Bei Regieberichten ist Materialbearbeitung unabhängig von der
Stundenbearbeitung. Die Menüanzeige prüft beide Freigaben am selben Projekt.
Eine Stundenfreigabe für eine andere Baustelle öffnet keine Bearbeitungsaktion.
Ohne Stundenfreigabe bleiben Arbeitszeiten in Ansicht und Ausgaben ausdrücklich
als nicht freigegeben markiert.

Lieferscheine, Bautagesberichte und Regieberichte besitzen jeweils eigene
Schlüsselbereiche pro Projekt. Eine Freigabe für Bautagesberichte öffnet keine
Regiestunden; eine Lieferscheinfreigabe öffnet kein Regiematerial. Auch die
Projektgrunddaten, Dateien und kaufmännischen Vorgänge bleiben davon unabhängig.
Die Preisfreigabe für Lieferscheine ist außerdem von Beschaffung und
Weitervergaben getrennt.

Rechnungswerte und die projektbezogene Werkzeugnutzung haben eigene Freigaben.
Die [Kostenübersicht](verschluesselte-projektkosten.md) zeigt betroffene
Projekte bei fehlenden Rechten mit leeren Beträgen und einer Erklärung.
Schreibrechte auf Projektgrunddaten erlauben keine Änderungen von
Rechnungssummen.

Projektanlage, Bereichserkennung und Freigabenmaske verwenden dasselbe
Bereichsverzeichnis. Neue Projekte erhalten alle darin beschriebenen Bereiche;
zusätzliche Berichtsrechte werden daraus nicht für andere Projekte abgeleitet.
Die TypeScript- und Rust-Prüfungen kontrollieren die Bindung neu angelegter
Berichtsbereiche an den ursprünglichen Projektanlagenachweis. Ein bloßes Recht,
neue Projekte anzulegen, reicht für Bereiche eines fremden Projekts nicht aus.

Die lokalen Kryptografie-, Modell- und Browsertests prüfen diese Trennung. Der
native Lauf über zwei unabhängige API-Instanzen prüft unter anderem
verschlüsselte Berichte, Werkzeugbuchungen und die Projektkosten nach der
Bestandsübernahme und nach zwei Seed-Recoveries. Der zusätzliche Test, der jeden
Projektbereich einzeln freigibt, entzieht und erneut freigibt, ist vorbereitet;
dieser vollständige Durchlauf steht noch aus.
