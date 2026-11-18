# Gemeinsame Texte in verschlüsselten GAEB-Dokumenten

Beim Kalkulieren können mehrere Bearbeiter denselben Positionstext ändern. Yjs
führt ihre Einfügungen und Löschungen im Browser zusammen. Der verschlüsselte
Nachrichtenweg ergänzt die gespeicherten XML-Stände um einzelne Textänderungen
und die Anzeige anderer Bearbeiter. Die noch offenen Prüfungen stehen am Ende
dieser Seite.

Mengen und Preise werden über den gespeicherten Dokumentstand abgeglichen. Für
sie besteht bislang keine eigene Übertragung einzelner Eingaben über den
Textkanal.

## Nachrichten statt Klartext-Dokumentsitzung

Der Browser schlägt den ersten gemeinsamen Zustand eines Textfelds verschlüsselt
vor. Bei gleichzeitigen Anfragen können mehrere solcher Vorschläge im Verlauf
stehen. Alle Empfänger prüfen sie in derselben Reihenfolge und übernehmen den
ersten gültigen Vorschlag. Dabei müssen der angegebene Ausgangstext und der
tatsächliche Yjs-Inhalt übereinstimmen; zusätzliche Felder oder fehlende
Abhängigkeiten sind unzulässig. Ein beschädigter Vorschlag blockiert dadurch
keine spätere Initialisierung. Weitere Änderungen verwenden dieselben
Yjs-Kennungen. Später beitretende Clients lesen den Verlauf nach und wählen
denselben Ausgangszustand.

Die Textnachrichten liegen als Ciphertexte im DuckDB-Datendienst. Dieser
speichert auch ihre technische Zuordnung, Signatur und Reihenfolge. Ein
gemeinsamer Transaktionsvergleich ordnet konkurrierende Schreibvorgänge aus
unterschiedlichen API-Instanzen. Jede Instanz liest das dauerhafte
Änderungsjournal und leitet die betreffenden Hinweise über ihre WebSockets
weiter. Eine Cursorbewegung löst keine erneute Vorgangsabfrage aus.

Erst bei der ersten Bearbeitung eines Feldes schlägt der Browser dessen
fehlenden Ausgangstext vor. Das Öffnen und Anzeigen unveränderter Felder erzeugt
keine Einträge im Textverlauf. Mehrere anstehende Vorschläge werden in Gruppen
von höchstens 16 Feldern übertragen. Pro Inhaltskanal laufen höchstens vier Übertragungen
gleichzeitig; anschließend wird ihr gemeinsamer Lesestand abgeglichen. Jeder
Vorschlag behält seine eigene Signatur und Wiederholungskennung. Die Gruppierung
verändert weder die Berechtigungsprüfung noch die Reihenfolge im gespeicherten
Nachrichtenverlauf.

Zeitnah angeforderte Kanalseiten werden ebenfalls gebündelt. Bis zu vier Kanäle
teilen sich eine Transaktion und die Prüfung ihrer Berechtigungsmetadaten; ihre
Lesestände bleiben getrennt. Antworten über acht MiB werden in kleinere Abrufe
aufgeteilt. Ein Berechtigungs- oder Versionsfehler verwirft dagegen den gesamten
betroffenen Abruf. Die Warteschlangen sind nach Konto getrennt, damit eine alte,
noch hängende Verbindung nach einem Kontowechsel keine neue blockiert.

Eine Rücksicherung erhält einen eigenen, signierten Fachstand. Neue
Live-Nachrichten und Speicherbelege enthalten dessen Fingerabdruck in ihrer
Signatur. Ein vor dem Wechsel geöffnetes Dokument behält seinen bisherigen
Fachstand auch bei einer unterbrochenen Verbindung. Die API weist verspätete
Schreibvorgänge und Abrufe mit einem alten Lesestand zurück. Ein neu geöffneter
Editor liest die übernommenen Nachrichten weiter. Anwesenheitsmeldungen aus dem
alten Fachstand erscheinen dort nicht.

Vorbereitete verschlüsselte Dokumentteile lösen noch kein Neuladen der
Vorgangsübersicht aus. Erst der veröffentlichte Dokumentkopf macht sie zum neuen
Speicherstand. Treffen während einer laufenden Listenabfrage mehrere Hinweise
ein, folgt eine gemeinsame neue Abfrage; das inzwischen überholte Ergebnis wird
verworfen. Zusammengehörige Lesezugriffe verwenden denselben geprüften
Berechtigungskontext. Ein Versionskonflikt verwirft diesen Kontext und lädt die
Nachweise erneut.

Namen und Textauswahl werden ebenfalls verschlüsselt. Diese kurzlebigen
Präsenzpakete liegen getrennt vom dauerhaften Textverlauf und laufen nach 45
Sekunden ab. Die API sieht weiterhin Benutzerkennungen, Dokumentzuordnungen,
Zeitpunkte und Datenmengen. Textinhalte, Anzeigenamen und markierte Textstellen
werden dabei nicht entschlüsselt.

Eine verlorene Bestätigung wird mit demselben signierten Paket wiederholt. Die
Wiederholung eines Präsenzpakets verlängert dessen ursprüngliche Lebensdauer
nicht. Geänderte Pakete mit derselben Präsenzversion werden zurückgewiesen.

Lange Positionstexte und Änderungen werden in mehrere verschlüsselte Pakete
aufgeteilt. Jedes Paket durchläuft die bisherige Rechte- und Signaturprüfung.
Der empfangende Browser setzt die Teile erst zusammen, wenn die Gruppe
vollständig ist. Dazu müssen Unterzeichner, Autoritätsgeneration, Fachstand
und Nachrichtentyp übereinstimmen. Der Editor übernimmt den zusammengesetzten
Text gemeinsam mit den übrigen Änderungen der Seite. Ein Paket enthält vor der
Verschlüsselung höchstens 64 KiB. Der Browser fügt Nachrichten bis zu zwei MiB
zusammen und hält pro Kanal bis zu acht unvollständige Gruppen vor. Muss er
eine ältere Gruppe verwerfen, erscheint im Editor ein Hinweis.

## Wiederanlauf nach dem Speichern

Beim Speichern eines Vorgangsdokuments oder GAEB-Projektanhangs kann der Browser
den gemeinsamen Yjs-Stand verschlüsselt ablegen. Dafür müssen alle Teilpakete
des betreffenden Kanals vorliegen und seine Texte zum gespeicherten XML passen.
Der signierte Speicherbeleg bindet den verschlüsselten Stand an den Kanal, die
abgedeckte Nachrichtenfolge und den exakten nativen Dokumentteil. Beleg und native
Änderung werden in derselben Transaktion bestätigt.

Ein Projektanhang verwendet den Schlüssel für Projektdateien. Sein einzelner
Nachrichtenkanal umfasst alle gemeinsam bearbeiteten Textbereiche des Anhangs.
Deshalb speichert der Browser deren Zustand zusammen und lädt ihn nur, wenn
jeder enthaltene Textbereich zur geöffneten XML-Datei passt. Der Beleg ist an
das Projekt, die Datei und den signierten Dateistand gebunden. Nach einer
Änderung am Dateieintrag, etwa einer Umbenennung, kann der Browser bis zum
nächsten bestätigten Zwischenstand den Verlauf ab Anfang lesen.
Dasselbe gilt, wenn der gemeinsame Zwischenstand die Grenze von 2 MiB
überschreitet.

Beim Öffnen prüft der Browser die Signatur, die damaligen Schreibrechte und
die Bindung an den geöffneten Fachstand. Nach dem Entschlüsseln vergleicht er
die enthaltenen Texte mit seiner lesbaren XML-Ansicht. Passt der Stand, liest
der Browser nur die späteren Nachrichten und behält die ursprünglichen
Yjs-Kennungen für weitere gemeinsame Änderungen. Fehlt ein passender
Wiederanlaufpunkt, etwa nach einer Rücksicherung, liest der Browser den
vollständigen Nachrichtenverlauf. Die bisherigen Nachrichten bleiben für
diesen Fall gespeichert.

Der Mehrinstanztest stellt eine X83 mit einem älteren Beleg wieder her. Nach
dem Nachlesen kann der Adapter den Wiederanlaufpunkt für den wiederhergestellten
Fachstand bestätigen. Die Revisionsnummer der X83 bleibt dabei erhalten.

## Rechte gelten auch beim Empfangen

Die API prüft den angemeldeten Benutzer, dessen Signatur, die aktuelle
Schlüsselgeneration und die nötigen Inhaltsrechte. Ein Empfänger prüft außerdem
die historische, signierte Freigabe des Absenders. Ein Benutzer mit Leserecht
kann dadurch keine Textänderung einschleusen, selbst wenn ein Speicherdienst
sein gültig signiertes Paket ungeprüft ausliefern würde. Präsenz benötigt
Leserechte; Textänderungen benötigen Bearbeitungsrechte.

Auch native Dokumentköpfe und Speicherbestätigungen weisen die damaligen
Schreibrechte ihres Unterzeichners nach. Dafür reichen öffentliche Nachweise der
Schlüsselbereiche: Sie enthalten die ursprüngliche Signatur und Prüfsummen der
Benutzerpakete, geben aber keine Benutzerschlüssel frei. Wer nur den
Dokumentkopf lesen darf, kann deshalb auch Änderungen an Preisbereichen prüfen,
ohne deren Inhalt zu entschlüsseln.

Die Prüfung eines Dokumentkopfs umfasst seine signierten Vorgänger. Ein späterer
berechtigter Unterzeichner macht dadurch keine zuvor unberechtigte Preisänderung
gültig. Bestehende Inhaltsteile dürfen nicht verschwinden; Schreibschutz und
endgültige Sperren gelten auch für Folgestände. Der Browser lädt die
öffentlichen Köpfe in Seiten mit jeweils höchstens 32 Einträgen und hält bereits
geprüfte Köpfe innerhalb des geöffneten Kontos vor. Beim nächsten Speichern muss
er so nur die neu hinzugekommenen Stände prüfen.

Die Nachweise binden den Unterzeichner an eine signierte Richtlinienversion. Sie
beweisen allein weder seinen tatsächlichen Signierzeitpunkt noch, dass der
Speicher den neuesten Stand liefert. Die
[Grenze der Aktualitätsprüfung](verschluesselung-datenpruefung.md#verantwortung-der-clients)
gilt auch für diese Dokumentköpfe.

Im Browser verwenden die Inhaltsbereiche getrennte Yjs-Zustände. Ein Feld der
Leistungsbeschreibung teilt dadurch keine Textkennungen mit Rechnungsfeldern.
Versandwarteschlangen und relative Cursorpositionen folgen derselben Zuordnung.
Bei aufgebauter Textverbindung behalten Rückgängig und Wiederholen die
Reihenfolge der lokalen Änderungen auch beim Wechsel zwischen Bereichen bei.
Schreibgeschützte Felder beginnen keine eigene Textsitzung und lassen sich nicht
durch die Synchronisationsschicht bearbeiten.

Auch Nachrichtenabruf, Verschlüsselung und Speicherbestätigungen folgen nun den
Inhaltsbereichen. Ein Textkanal braucht den Schlüssel für
Leistungsbeschreibungen, ein Rechnungskanal den Rechnungsschlüssel. Kanal,
Dokument und Nachrichtenzweck sind an die Signatur und den
Verschlüsselungskontext gebunden. Ein Paket aus dem Rechnungskanal lässt sich
dadurch nicht als Textänderung ausliefern. Unbekannte XML-Inhalte benötigen
weiterhin alle neun Inhaltsschlüssel. Projektdateien verwenden ihren
Anlagenschlüssel.

Jeder Kanal hält seinen eigenen Lesestand und seine eigene Verbindung. Eine
Benachrichtigung über einen Textkanal lädt deshalb keine Preisnachrichten nach.
Präsenzanzeigen aus mehreren freigegebenen Kanälen werden pro Verbindung
zusammengeführt; die Oberfläche zeigt dieselbe Person nicht mehrfach an.

Fehlerhafte CRDT-Strukturen werden vor dem Anwenden an einer getrennten Kopie
geprüft. Eingebettete Objekte, unerwartete Formatattribute und übergroße
Zustände werden zurückgewiesen. Die ursprüngliche XML-Struktur und ihre
Formatierung bleiben außerhalb dieses Text-CRDT erhalten.

## Positionstexte ohne Preisfreigabe

Ein Bearbeiter soll Leistungsbeschreibungen ändern können, ohne dazu Mengen,
Kalkulation oder Rechnungspreise zu erhalten. Der Dokumentenspeicher kann solche
Teilansichten bereits lesen und geänderte Texte veröffentlichen. Ungelesene
Inhalte bleiben als verschlüsselte Teile unverändert. Die öffentliche Struktur
enthält nur Verweise auf sie. Beim Bearbeiten dürfen diese Verweise weder
zwischen Positionen vertauscht noch einzeln entfernt oder neu erfunden werden.
Auch unbekannte Herstellerangaben bleiben erhalten.

Metadatenfelder verwenden XML-Pfade statt ihrer Nummer in einer Feldliste. Wird
ein Rechnungsheader ausgeblendet, bleibt dadurch etwa die Empfängeranschrift
unter derselben Kennung erreichbar. Beim Zurückschreiben wird das Feld im
jeweiligen nativen Stand erneut aufgelöst. Parser und Editor verwenden dieselbe
Zuordnung zu Inhaltsbereichen; auch ein erkanntes Feld innerhalb einer
unbekannten Herstellerstruktur bleibt geschützt.

Der Speicher liefert dazu getrennte Lese- und Schreibrechte für die
Editor-Komponente. Deren Canvas legt für verborgene Mengen und Preise keine
Eingabefelder an. Sichtbare Preise mit bloßem Leserecht bleiben
schreibgeschützt. Wird einem gerade ausgewählten Feld die Freigabe entzogen,
leert die Komponente ihren Eingabepuffer und die zugehörige
Zwischenablagequelle. Bei Weitervergaben richten sich Preisfelder nach den
Rechten des Vorgangs; ein entsprechender Vermerk in der XML-Datei ist dafür
nicht erforderlich. Fehlende Preise werden nicht durch null ersetzt. Eine
Teilansicht wird nicht in den lokalen Positionsindex übernommen.

Eine solche Ansicht lässt sich nicht gegen das vollständige GAEB-Schema prüfen,
weil dafür die fehlenden Inhalte nötig wären. Stattdessen prüft der XML-Worker
die Struktur, die erhaltenen Verweise und die tatsächlich bearbeitbaren Bereiche
gegen den zuvor geprüften Dokumentstand. Erst ein Client mit allen nötigen
Schlüsseln kann die vollständige Datei wiederherstellen und gegen das Schema
prüfen. Eine erfolgreiche Teilprüfung wird deshalb nicht als gültiges
GAEB-Schema ausgewiesen.

Der Download der ursprünglichen X-Datei prüft deren eigenen vollständigen Inhalt
und die angeforderte aktuelle Version. Er braucht keine weiteren Inhalte aus
einer getrennten Referenzdatei. So lässt sich beispielsweise eine vollständig
lesbare X84 herunterladen, obwohl eine interne Notiz ihrer X83 verborgen ist.
Eine unvollständige X-Datei wird dagegen nicht als Original angeboten. Für
ausgestellte Rechnungen gilt beim Download dieselbe Prüfung des
festgeschriebenen Dokumentstands wie beim Öffnen.

Die Vorgangsansicht fragt die signierten Stände ihrer Dateien gebündelt ab. Die
Betragsanzeige und die Dateiliste verwenden dieselben geprüften Stände.
Beim Öffnen hat die aktive Datei Vorrang vor dem Auftragsvergleich. Wenn der
Vergleich mehrere Dateien desselben Vorgangs öffnet, teilen sie sich den
laufenden Abruf der Vorgangsdaten.

Beim Download aus dem Menüband liest der Browser Dateiname und Inhalt in einem
Vorgang. Er verwendet den geprüften Zugriff auf den Vorgang für die
Inhaltsprüfung weiter. Ein Wechsel des Kontos oder der Freigabe bricht die
Ausgabe einer noch laufenden Anfrage ab.

Beim Drucken prüft der XML-Worker dagegen, ob alle tatsächlich dargestellten
Inhalte lesbar sind. Verborgene interne Notizen neben einer Position verhindern
den Druck nicht. Ein ungelesenes Bild oder ein unbekannter Zusatz innerhalb der
Beschreibung sperrt ihn. Bei einem Aufmaß müssen die Beschreibungen und Bilder
der aufgemessenen Positionen lesbar sein; andere Positionen der Quelldatei sind
dafür nicht erforderlich. Eine X84 verwendet den verknüpften X83-Stand für
Beschreibung und Mengen. Dessen interne Preise werden nicht mitgedruckt.

Die Druckansicht bleibt vom Original getrennt. Vor jedem Druck prüft der Worker
die aktuellen Änderungen und die unterstützte Berechnung. Fehlende Mengen oder
Preise ergeben keinen Nullbetrag. Ein noch unvollständig kalkuliertes Angebot
bleibt bearbeitbar; nach der letzten Preiseingabe wird der Druck im selben
Dialog verfügbar. Fehlende Bilder, Texte oder Referenzinhalte werden davon
getrennt geprüft und sperren den Druck weiterhin. Vollständig lesbare Dateien
mit nicht unterstützten Preisregeln behalten ihre ausgewiesenen Beträge. Die
Kompilierung mit Typst läuft anschließend im Browser. Ein Rechteentzug oder das
Schließen des Editors verwirft noch laufende Prüfungen.

Dateien mit einer XML-Signatur bleiben schreibgeschützt. Ihre unveränderte
Ansicht lässt sich drucken, ohne die native Datei umzuschreiben. Schon eine
abweichende Leerstelle wird bei diesem Leseweg zurückgewiesen. Die Druckprüfung
bewertet keine Zertifikate und bestätigt nicht die Gültigkeit einer externen
XML-Signatur; sie erhält die vorhandenen Inhalte.

Der kaufmännische Vorgangsdialog öffnet solche Teilansichten jetzt über einen
eigenen Browserzugang. Er reicht die geprüften Freigaben an Canvas,
Live-Verbindung und Speichervorgang weiter. Ein Bearbeiter kann Positionstexte
ändern, obwohl das Verwaltungsrecht für den Vorgang fehlt. Ohne entsprechende
Stammdatenrechte bleibt dessen interne Bezeichnung schreibgeschützt.

Beim Speichern prüft der XML-Worker die geänderte Ansicht erneut gegen den
aktuellen nativen Stand. Eine reine Textänderung schreibt keine Rechnungsdaten
neu und verlangt deshalb weder Rechnungsschlüssel noch Rechte auf die
Abrechnungsgrundlage. Ohne lesbare Berechnungsgrundlage enthält auch die
Rückmeldung an die Liste keinen Ersatzbetrag. Bestätigungen für ungelesene
Preisbereiche weist die API weiterhin zurück.

Preise lassen sich unabhängig von unbekannten Erweiterungen bearbeiten, wenn die
Leistungsbeschreibung, die zugehörigen Mengen und der Preisbereich lesbar sind.
Die zusätzliche Berechnungsprüfung im XML-Worker verwendet Dezimalzahlen und
rundet jeden Positionsbetrag einzeln. Sie berücksichtigt Pauschalpositionen,
Bedarfspositionen, ausgeschlossene Leistungen sowie Nachlässe auf Positionen,
Gruppen und das gesamte Angebot. Direkte Positionen und Untergruppen können
gemeinsam in einer Gruppe stehen. Lieferantenpreise mit einer einfachen
Preisbasis werden ebenfalls berechnet. Für noch nicht unterstützte Regeln, etwa
Zuschlagspositionen oder aufgeteilte Einheitspreise, bleiben die kaufmännischen
Felder gesperrt; die Originalinhalte bleiben erhalten.

Ein Angebot darf noch unbepreiste Positionen enthalten. Mit Preisrechten lassen
sich einzelne EP eintragen, als Zwischenstand speichern und später ergänzen.
Solange benötigte Mengen oder Preise fehlen, bleibt die Gesamtsumme offen. Ein
vorhandener, veralteter Positionsbetrag wird im bearbeitbaren Dokument nicht als
neu berechneter Wert angezeigt. Auch bei einem unvollständigen Entwurf prüft der
Worker die übrigen Positionen und Berechnungsregeln; fehlende Eingaben verdecken
keine ungültigen Preise oder Zuschläge.

Optionale Preisfelder haben bereits vor dem ersten Eintrag einen festen
verschlüsselten Platz. Dieser Platz ergibt in der X-Datei zunächst keinen Text.
Beim Ausfüllen muss deshalb kein Verweis im Bereich der Leistungsbeschreibung
ergänzt werden. Reine Preisrechte reichen dafür aus. Die ursprüngliche
Schreibweise einer leeren Position, etwa `<Item/>`, bleibt beim Lesen erhalten.
Nach dem Eintragen erweitert der Renderer sie um das Preisfeld. Verborgene
Attribute und andere Inhaltsbereiche bleiben unverändert.

Wer Mengen bearbeiten und Preise lesen darf, kann Mengen ändern, ohne dadurch
Schreibrechte auf Einheitspreise oder Nachlässe zu erhalten. Die verschlüsselten
Preisblöcke bleiben dabei unverändert. Aus dem signierten Dokumentverlauf lässt
sich erkennen, auf welchen Mengenstand sich ihre gespeicherten Summen beziehen.
Bei geänderten Berechnungsgrundlagen berechnet der Browser Positionsbeträge,
Gruppensummen und Steuern erneut. Dokumentansicht, Vorgangsdetail und Liste
verwenden diese aktuellen Werte. Ein vollständiger Download setzt sie auch in
der X-Datei ein; unbekannte Inhalte bleiben erhalten.

Diese berechnete Lesesicht ersetzt keinen signierten Speicherstand.
Konfliktprüfungen vergleichen weiterhin die unveränderten gespeicherten Zeilen.
Bei der Annahme und anschließenden Projektanlage zählt dagegen der aktuelle
Angebotsbetrag, damit das Projektbudget die bearbeiteten Mengen berücksichtigt.

Die Prüfung unterscheidet zwischen geschützten Eingaben und berechneten Werten.
Eine Mengenänderung darf deshalb den daraus folgenden Positionsbetrag ändern,
aber keinen beliebigen Betrag, EP oder festen Nachlass einschleusen. Fehlen nach
einem Rechteentzug die nötigen Eingaben, erscheint keine vermeintlich aktuelle
Summe. Reine Textänderungen lösen keine neue Kalkulation aus.

Eine X84 darf Mengen aus ihrer verknüpften X83 verwenden, ohne sie beim
Preisändern in den eigenen Mengenbereich zu kopieren. Anzeige, Neuberechnung und
Speichern verwenden dieselbe freigegebene Referenz. Fehlen deren
Mengenschlüssel, bleibt die Kalkulation gesperrt. Nach einer Änderung der X83
bleibt der bisherige Mengenstand sichtbar; ein stiller Wechsel auf neue Mengen
ist ausgeschlossen. Bei einer älteren Zwischenreferenz, deren ursprüngliche
Verknüpfung sich nicht belegen lässt, wird keine neuere Referenz eingesetzt.

Rechnungsbeträge können sichtbar bleiben, obwohl die zum Bearbeiten nötige
Auftragsabrechnung nicht freigegeben ist. Dann sind die Rechnungsfelder
schreibgeschützt. Sobald auch dieser Zusammenhang lesbar ist, prüft der Browser
Änderungen gegen die vollständige Abschlagskette. Eine Schlussrechnung ohne
lesbare ursprüngliche Nettobeträge erhält keine aus Umsatzsteuer
zurückgerechnete Ersatzsumme. Ein nicht lesbarer Quellauftrag liefert keine
zusätzliche Referenzansicht. Unprüfbare Signaturen oder technische Fehler gelten
dabei nicht als fehlende Freigabe.

## Unterbrechungen und fehlerhafte Pakete

Der Browser bereitet jede gelesene Seite getrennt vom Editor vor. Erst wenn ihre
Reihenfolge und ihr Endpunkt stimmen, übernimmt er die geprüften Texte und
Ausgangswerte gemeinsam und setzt seinen Lesestand weiter. Währenddessen
eingegebener lokaler Text bleibt erhalten.

Eine Seite aus dem Textkanal darf keine Rechnungsfelder initialisieren oder
ändern. Der Browser prüft diese Zuordnung auch innerhalb gültig verschlüsselter
Pakete. Eine verworfene Seite hinterlässt keine halbfertige Initialisierung.

Ein fehlerhaftes Inhaltspaket wird einzeln verworfen. Dazu gehören falsche
Signaturen und gültig signierte Pakete mit unzulässigem Yjs-Inhalt. Die übrigen
Änderungen werden weiter verarbeitet; der Editor zeigt einen Hinweis auf die
verworfene Änderung. Unprüfbare Präsenzpakete werden ausgeblendet und halten das
Speichern der Texte nicht auf.

Fehlen dagegen ein Bereichsschlüssel oder ein verifizierter Richtliniennachweis,
bleibt die ganze betroffene Seite unverarbeitet. Der Browser verwirft deshalb
keine gültige Änderung nur wegen eines ausgefallenen Nachweisdienstes. Ein
Rechteentzug unterbricht auch eine gerade laufende Übernahme. Bei neu
eingeladenen Bearbeitern oder einer neuen Schlüsselgeneration werden die
Nachweise zunächst erneut geladen, bevor ein Paket wegen eines unbekannten
Absenders abgewiesen wird.

Nach einem Verbindungsfehler versucht der Browser den Aufbau automatisch erneut;
die Wartezeit steigt bis auf 15 Sekunden. Eine neue Online-Meldung des Browsers
oder eine Benachrichtigung über das Dokument stößt den Abgleich früher an. Noch
nicht bestätigte Texte bleiben vorgemerkt. Cursorbewegungen sammeln während
einer Unterbrechung keine eigene Versandwarteschlange an. Das Schließen des
Dialogs beendet die Wiederholungen.

## Textstand speichern und abschließen

Vor dem Speichern wartet der Browser auf die Bestätigung seiner Textänderungen
und liest inzwischen eingetroffene Änderungen nach. Er signiert anschließend
eine Bestätigung je geändertem Inhaltsbereich. Sie bindet dessen geprüften
Nachrichtenstand an den verschlüsselten Inhaltsteil und seine
Schlüsselgenerationen. Unveränderte Inhaltsteile behalten ihre Bestätigung auch
bei einer neuen Version des Dokumentkopfs. Bei Projektdateien ist das Ziel das
signierte Dateipaket. Die API prüft diesen Stand unter derselben
Transaktionssperre, die auch neue Textnachrichten ordnet. Dokument, Bestätigung
und betroffene Fachdaten werden gemeinsam veröffentlicht. Trifft über eine
andere API-Instanz vorher noch eine Änderung ein, muss der Browser neu
abgleichen und den Speichervorgang wiederholen.

Zum bestätigten Stand gehören auch geprüfte Initialisierungen und einzeln
verworfene Inhaltspakete. Andernfalls könnte schon eine Initialisierung ohne
weitere Textänderung das anschließende Speichern blockieren. Verworfene Inhalte
gehen dabei nicht in die native Datei ein.

Auch nach Tippen und anschließendem Rückgängig kann ein neuer Nachrichtenstand
vorliegen, obwohl die XML-Datei unverändert ist. Dann wird nur die signierte
Bestätigung ergänzt. Die Dateiversion bleibt gleich. Eine Umbenennung behält den
zuletzt übernommenen Textstand bei; sie bestätigt keine späteren Texte.

Eine endgültige Sperre verlangt, dass alle bis dahin akzeptierten Textänderungen
in sämtlichen Kanälen bestätigt sind. Auch eine bereits gespeicherte gültige
Bestätigung darf keine späteren Änderungen verdecken. Der Editor zeigt danach
die signierte native Datei an und legt keinen alten Live-Text darüber. Noch
nicht übernommene lokale Änderungen bleiben im geöffneten Dialog als separat
herunterladbarer Entwurf erhalten. Ein Entwurf aus einer Teilansicht wird als
JSON mit entsprechender Kennzeichnung gesichert. Er wird nicht als vollständige
GAEB-Datei angeboten; ein eigener Arbeitsablauf zum späteren Zusammenführen
dieses Entwurfs fehlt noch.

Die API prüft dabei die technische Reihenfolge und die Schreibberechtigung. Ob
eine XML-Datei die bestätigten Texte tatsächlich enthält, prüfen die Clients.
Diese Grenze entspricht der übrigen clientseitigen Inhaltsprüfung.

## Prüfstand und weitere Arbeit

Der [Browserfall](../sortsys-webapp-v2/scripts/ui/crypto.browser.mjs) verwendet
drei Verbindungen eines Kontos. Er prüft gleichzeitige Einfügungen
einschließlich Emoji, den späteren Beitritt und verschlüsselte Textauswahl. Der
[native Test](../sortsys-webapp-v2/scripts/test-live-document-messages.ts)
verwendet zwei unabhängige API-Instanzen, echte Datenbanken und lokale
Yjs-Instanzen. Er prüft den gemeinsamen Ausgangszustand, die
Nachrichtenreihenfolge, Textkonvergenz und abgewiesene Absenderfälschungen.
Modultests prüfen zusätzlich die unabhängige Rechteprüfung im Empfänger und den
unveränderten Text nach einem fehlerhaften CRDT-Paket.

Weitere Browserfälle prüfen den Verbindungsaufbau nach einem Fehler, erhaltene
Offline-Eingaben, einen unzulässigen ersten Initialisierungsvorschlag, einzelne
fehlerhafte Text- und Präsenzpakete, fehlende Nachweise, verlorene Bestätigungen
und den Rechteentzug während einer laufenden Abfrage. Sie verwenden die echten
Browserparser und Kryptografiefunktionen; der Speicherdienst wird dabei gezielt
mit Fehlern versehen.

Ein weiterer Browserfall bearbeitet Leistungsbeschreibung und Rechnungsdatum
über getrennte verschlüsselte Kanäle. Beide Texte bleiben in getrennten
Zuständen erhalten und erreichen einen später beitretenden Client. Die Prüfung
der Metadaten verwendet außerdem eine vollständige Rechnung und eine Teilansicht
ohne Rechnungsheader: Beide ändern dieselbe Empfängeranschrift, obwohl deren
Feldnummern voneinander abweichen. Ein Scope-Paket für das Rechnungsdatum wird
bereits vor dem Aufbau der Eingabefelder zurückgewiesen.

Der native Lauf prüft auch Veröffentlichungs- und Sperrkonflikte über beide
API-Instanzen, Bestätigungen ohne neue Dateiversion und verlorene Antworten. Ein
älterer gültiger Nachweis wird dabei direkt an die API gesendet, nachdem weitere
Textänderungen angenommen wurden. Die Sperre muss auch bei diesem
Wiederholungsversuch scheitern. Ein Nutzer mit reinen Textrechten kann eigene
Textnachrichten und deren Übernahme bestätigen; Rechnungskanäle bleiben für
dieses Konto gesperrt. Bei Projektdateien wird zusätzlich geprüft, dass
Umbenennen den übernommenen Textstand nicht vorzieht. Nach zwei
Wiederherstellungen lassen sich die alten Nachrichten erneut entschlüsseln und
Projektdateien unter der neuen Autoritätsgeneration bestätigen.

Ein zusätzlicher Browserfall prüft den tatsächlichen Dokumentenspeicher mit
echten Signaturen und einem simulierten Speicherdienst. Gültig signierte
Leserfälschungen werden sowohl beim Abrufen eines Kopfs als auch beim direkten
Laden abgewiesen, bevor der XML-Renderer oder eine Schlüsselleseoperation
erreicht wird. Der native Lauf prüft außerdem ein eingeladenes Benutzerkonto,
das ausschließlich den Kopf lesen darf: Öffentliche Bereichsnachweise sind
zugänglich, die zugehörigen Rechnungsschlüssel und Benutzerpakete bleiben
gesperrt.

Die
[Browserfälle für Teilansichten](../sortsys-webapp-v2/scripts/ui/gaeb-partial.fixture.jsx)
verwenden den echten XML-Worker und den Canvas-Editor. Eine per Tastatur
geänderte Beschreibung ergibt beim Wiederzusammenführen die ursprüngliche native
Datei mit genau dieser Textänderung. Mengen und Preise fehlen in der
Teilansicht, bleiben aber in der vollständigen Datei erhalten. Weitere Prüfungen
verhindern eingeschleuste Preise und Änderungen an lesbaren, schreibgeschützten
Feldern. Der
[native Teilfreigabetest](../sortsys-webapp-v2/scripts/test-live-partial-document.ts)
verwendet ein eigenständiges Benutzerkonto mit Textfreigabe über zwei
API-Instanzen.

Die [Preisfälle](../sortsys-webapp-v2/scripts/test-live-financial-view.ts)
ergänzen Rechnungsänderungen ohne Zugriff auf vertrauliche Notizen und eine X84
mit separat freigegebenen X83-Mengen. Sie prüfen auch Mengenentzug und eine
geänderte Quellversion. Der echte Editordialog wird im
[Browser](../sortsys-webapp-v2/scripts/ui/private-editors.browser.mjs) mit
beiden Mengenvarianten bearbeitet und gespeichert. Die übernommene Menge bleibt
dabei außerhalb des geänderten Preisbereichs.

Ein weiterer Mehrinstanzfall verwendet ein Konto mit Mengen-Schreibrecht und nur
lesbaren Preisen. Er prüft wiederholtes Speichern, die unveränderten
Preisblöcke, aktuelle Beträge in Dokument, Detail und Liste, den vollständigen
Download, die Projektanlage und die Ablehnung eingeschleuster EP. Der
Browserfall ändert die Menge im tatsächlichen Dialog und liest den neuen Betrag
aus dem erzeugten PDF.

Die Druckfälle verwenden den tatsächlichen Typst-Compiler und lesen die
erzeugten PDFs mit PDF.js. Sie prüfen Vertragswerte, Empfänger und Bauvorhaben
für eine eigenständige X86 und eine X84 mit Referenz. Ein weiteres Paar von
Fällen zeigt, dass ein eingebettetes Bild den Druck ohne Anlagenfreigabe sperrt
und nach der Freigabe im PDF erscheint. Ein zunächst unbepreistes Angebot wird
ohne erneutes Öffnen fertig kalkuliert und gedruckt. Eine RSA-signierte, gegen
das GAEB-3.1-Schema geprüfte X84 bleibt beim Lesen bytegleich und ist im Dialog
druckbar. Der Kerntest prüft dafür auch den Inhaltsfingerabdruck und die
tatsächliche RSA-Signatur der Testdatei. Die Tests für den Editorzugang prüfen
außerdem den Abbruch bei Rechteentzug und nach dem Schließen des Dialogs.

Ein [E2E-Ablauf](../sortsys-webapp-v2/scripts/e2e/development.browser.mjs)
öffnet die gebaute Anwendung in zwei Browserkontexten mit demselben Konto. Jeder
Kontext verwendet eine andere API-Instanz. Der Test ändert Preise in beiden
Richtungen, öffnet den bestätigten Stand erneut und prüft einen Textabgleich,
während die Veröffentlichung des nativen Dokuments noch angehalten ist. Die
Anwendungspfade werden dabei nicht ersetzt; lediglich die externen
Zeitstempelserver sind gezielt nicht verfügbar.

Ein zweiter Ablauf verwendet John als Administrator und Frank mit begrenzten
Dokumentrechten, wiederum an getrennten API-Instanzen. Die Freigabe erfolgt in
der normalen Benutzerverwaltung. Frank ändert die Bezeichnung des Bauvorhabens
ohne Preisfelder; John erhält die Änderung bereits vor der Veröffentlichung des
nativen Dokuments. Der Test prüft das erneute Öffnen, das Entfernen der Ansicht
nach einem Rechteentzug und eine spätere reine Lesefreigabe. Inhalte, die John
nach dem Entzug ergänzt, bleiben bis zur erneuten Freigabe verborgen.

Für eine neu erstellte X83 umfasst die Prüfung auch das Anlegen einer Position
mit zwei Absätzen. John und Frank ergänzen verschiedene Absätze derselben
Position, während die Veröffentlichung der nativen Datei angehalten ist.
Beide sehen die zusammengeführten Texte schon über den Live-Kanal. Franks
Freigabe umfasst das Lesen der Vertragsmenge. Die Gliederung bleibt gesperrt.
Nach dem Speichern zeigt Franks Browser beide Texte auch nach einem Neuladen.
Die heruntergeladene X83 enthält sie als zwei native Absätze und behält die
ursprüngliche Menge.

Anschließend fügt John rund 81.000 Zeichen ein. Der Test hält die Veröffentlichung
der X83 erneut an. Frank empfängt den vollständigen Text über mehrere
verschlüsselte Pakete. Beim erneuten Öffnen setzt sein Browser hinter dem
gespeicherten Wiederanlaufpunkt an. Eine weitere Änderung erreicht ihn über
die zweite API-Instanz, während die nächste X83-Fassung noch unveröffentlicht ist.

Der Browserfall für Projektanhänge lädt eine X83 in die Projektablage, ändert
eine Positionsbeschreibung und öffnet den Dateilink über die zweite API-Instanz.
Der zweite Browser liest ab dem gespeicherten Zwischenstand und empfängt die
nächste Änderung vor der Veröffentlichung der XML-Datei. Der native Test
weist Schreibversuche ohne Beleg oder mit abweichender Prüfsumme ab. Er prüft
auch, dass die API einen Lesezugriff ohne Dateifreigabe verweigert.

Der Textabgleich berücksichtigt auch Eingaben während des Verbindungsaufbaus.
Deren Ausgangspunkt ist der sichtbare Dokumentstand, selbst wenn der gemeinsame
Nachrichtenverlauf mit einem älteren Text beginnt. Ein bereits nachgelesener
Dokumenttext wird beim Registrieren der Eingabefelder nicht nochmals als lokale
Änderung vorgemerkt.

Für Wiederverbindungen nach längeren Unterbrechungen fehlen weitere gemeinsame
Browser- und Mehrinstanztests.
