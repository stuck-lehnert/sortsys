# Werkzeuge im verschlüsselten Arbeitsbereich

Werkzeuge, Ausgaben, Rückgaben und Inventuren verwenden die bisherigen
Oberflächen. Der Browser liest und verändert ihre Daten über den gemeinsamen
Datenkern. Suchbegriffe, Werkzeugbezeichnungen und Kosten werden dabei nicht an
die Geschäftsdaten-Endpunkte der API geschickt.

Jedes Werkzeug hat eigene Bereiche für Stammdaten, Kosten und Inventuren. Jede
Buchung hat ebenfalls eigene Bereiche: Buchungsdaten, historische Nutzungskosten
und Umbuchungsanfragen. Eine Freigabe für eine einzelne Buchung öffnet damit
weder andere Buchungen noch deren Kosten. Der verschlüsselte Nummernindex
enthält die Kennungen und internen Nummern der Werkzeuge. Er verhindert, dass
zwei reguläre Clients dieselbe Nummer gleichzeitig vergeben.

Bei einem Benutzerkonto öffnet die Aktion „Berechtigungen verwalten“ die
Freigaben. Dort lässt sich ein Werkzeug suchen und der Zugriff auf Stammdaten,
Anschaffung und Nutzungskosten sowie Inventuren getrennt einstellen. Für eine
einzelne Buchung stehen Buchungsdaten, historische Nutzungskosten und
Umbuchungsanfragen zur Auswahl. Nur ausdrücklich geänderte Rechte werden
gespeichert; bestehende Einzelrechte und Kostenbeschränkungen bleiben erhalten.

Ein Mitarbeiter kann damit die Modellbezeichnung eines freigegebenen Werkzeugs
ändern, ohne Kaufpreis oder Nutzungskosten zu erhalten. Die Detailansicht prüft
ihre Aktionen am geöffneten Werkzeug und an dessen aktiver Buchung. Schreibrechte
für ein anderes Werkzeug schalten diese Aktionen nicht frei. Die Auswahl lädt
nur freigegebene Stammdaten und verwendet für die dabei gelesenen Bereiche einen
gemeinsam geprüften Berechtigungsstand.

Beim Öffnen der Detailansicht werden zuerst die Stammdaten und der Status des
Werkzeugs geladen. Der Inventurabruf bleibt auf dieses Werkzeug beschränkt.
Die Buchungshistorie und die dafür benötigten Freigaben werden anschließend
gelesen. Das Öffnen der Historie löst keine Änderungen an Buchungsfreigaben aus.

Bei der Rückgabe öffnet der Browser die aktive Buchung über den gespeicherten
Verweis am Werkzeug. Er beendet die Buchung, schließt offene Umbuchungsanfragen
und setzt den Werkzeugstatus in derselben Veröffentlichung. Hat eine zweite
Sitzung die Buchung inzwischen geändert, wird die Rückgabe abgewiesen.

Unter „Anlageberechtigungen“ erlaubt „Neue Werkzeugbuchungen anlegen“ die Ausgabe
und eine angenommene Umbuchung. Diese Freigabe öffnet keine bestehenden Werkzeuge
und ersetzt deren nötige Einzelrechte nicht. Ein Entzug verhindert neue
Buchungen; bereits angelegte Buchungen behalten ihre eigenen Freigaben. Der
verpflichtende Administrator erhält bei einer neuen Buchung ebenfalls deren
Schlüssel, ohne dass der Ersteller den privaten Mandantenschlüssel bekommt.

Ein abgebrochener Speicherversuch kann bereits leere Schlüsselbereiche
hinterlassen. Sie umgehen einen späteren Entzug des Anlegerechts nicht: Die API
prüft dieses Recht beim ersten Veröffentlichen des Buchungsdatensatzes erneut.
Ein nativer Mehrinstanztest reproduziert diesen Fall bei einer Sammelbuchung und prüft,
dass bestehende Buchungen und Werkzeugdaten unverändert bleiben.

Der Browserlauf mit John und Frank verwendet zwei API-Instanzen und prüft diesen
Ablauf über die tatsächlichen Formulare. Dazu gehören die Änderung ohne
Kostenfreigabe, unveränderte Preise, der Rechteentzug und die erneute Freigabe
zum Lesen. Schreibrechte für ein zweites Werkzeug öffnen dabei keine Aktionen
beim ersten. Die Auswahl und die getrennten Buchungsfreigaben haben zusätzliche
Tests mit echten kryptografischen Nachweisen.

Wird eine neue Buchung einem bereits kryptografisch registrierten Mitarbeiter
zugewiesen, erhält dieser automatisch Leserechte für die Buchungsdaten und
Umbuchungsanfragen. Die Kosten bleiben gesperrt; Bearbeitungsrechte werden
dadurch nicht vergeben. Die Buchung enthält eine verschlüsselte Kopie der
Werkzeugbezeichnung. Damit bleibt sie auch ohne Freigabe der Werkzeugstammdaten
verständlich. Ein Link zu deren Detailansicht erscheint nur bei lesbaren
Stammdaten.

Wurde die Buchung vor der Registrierung des Mitarbeiters angelegt, führt die
Bestätigung seiner Einladung die Lesefreigabe nach. Der Browser des Administrators
liest dafür die zuständige Person aus dem entschlüsselten Buchungsdatensatz.
Fehlt dessen Aktivitätsnachweis noch, erhält derselbe Inhalt eine neue signierte
Fassung. Eine wiederholte Prüfung verändert weder die Buchung noch die Freigaben
erneut. Bereits zurückgegebene Werkzeuge bleiben für diesen Zugang gesperrt.

Die nachträgliche Freigabe ist an einen eigenen, signierten Auftrag und den
aktuellen Aktivitätsnachweis der Buchung gebunden. Der Auftrag allein öffnet
keinen Datenbereich. Er erlaubt nur Lesen von Buchungsdaten und
Umbuchungsanfragen; Kosten und Werkzeugstammdaten bleiben getrennt. Ein
ausdrückliches Verbot bleibt wirksam. Die Rückgabe beendet das abgeleitete
Leserecht auch dann, wenn der ursprüngliche Auftrag noch gespeichert ist.

Ein signierter Zuständigkeitsnachweis ist an die genaue verschlüsselte
Buchungsrevision gebunden. Er wird gemeinsam mit der Buchung veröffentlicht.
Die Rückgabe oder Umbuchung beendet das abgeleitete Leserecht. Ein fehlender
Nachweis oder das erneute Senden einer alten Bereichsdefinition stellt es nicht
wieder her. Nach dem Abschluss kann die Administration neue Schlüssel für die
betroffenen Bereiche verteilen. Hat die buchende Person eine Schlüsselzuständigkeit
für einen dieser Bereiche, erledigt ihr Browser den Wechsel direkt. Ehemalige Empfänger
können damit spätere Änderungen auch mit einem behaltenen alten Schlüssel nicht
lesen. Bereits entschlüsselte Inhalte lassen sich ihnen nicht entziehen.

Ein Browserlauf mit getrennten Sitzungen prüft die automatische Freigabe in
Tabelle und Kartenansicht, den fehlenden Link zu gesperrten Werkzeugstammdaten
und den Entzug nach der Rückgabe. Der Schlüsselwechsel verwirft dabei nicht den
unveränderten Zugriffskontext des Administrators.

Der native Sammelbuchungstest prüft außerdem die nachträgliche Freigabe bei
Einladungsbestätigung. Mit `SORTSYS_NATIVE_BROWSER=1` öffnet er dafür die
Produktionsoberfläche an der zweiten API-Instanz. Die aktive Buchung muss
sichtbar sein, die zurückgegebene Buchung und der Link zu den Werkzeugstammdaten
müssen fehlen. Nach der Rückgabe durch die erste Instanz verschwindet die
Buchung auch im bereits geöffneten Browser. Ein anschließendes Neuladen darf
sie nicht wieder anzeigen. Beide API-Router laufen in diesem Test in einem
Rust-Prozess; der Ablauf prüft keine getrennten Betriebssystemprozesse.

Ein nativer Test durchläuft außerdem zwei Mandantenwiederherstellungen mit
aktiven und zurückgegebenen Werkzeugbuchungen. Der neue Administrator kann die
Buchungen lesen und Werkzeuge zurücknehmen; Preise und frühere Änderungen
bleiben erhalten. Alte Mitarbeiterzertifikate bleiben nach dem Wechsel
gesperrt. Wird die Einladung eines Verantwortlichen erneut bestätigt, erhält
er Leserechte für seine noch aktive Buchung. Zurückgegebene Buchungen und
Kosten bleiben verborgen. Das prüft der Test nach beiden Wiederherstellungen.
Nach einer Rückgabe öffnet auch ein behaltener alter Schlüssel keine späteren
Änderungen.

Fehlt ein Anlagenachweis unter der aktuellen Mandantenautorität, bestätigt der
Browser des Administrators den vorhandenen Buchungsbereich erneut. Diese
Bestätigung benötigt eine Signatur mit dem privaten Mandantenschlüssel und
bindet die genaue Ausgangsrevision samt Paketsignatur. Die API speichert beide
Nachweise gemeinsam oder keinen. Sie liest dafür keine Buchungsinhalte.
Die Bestätigung ersetzt weder historische Inhalte noch deren Urheber und
erteilt allein keine Mitarbeiterfreigabe. Erst der anschließende Abgleich
prüft im Browser die tatsächliche Zuständigkeit und die bestätigte Identität.
Eine verlorene Speicherantwort lässt sich durch geprüfte Rücklese bestätigen;
eine Wiederholung entfernt keinen inzwischen veröffentlichten Aktivitätsnachweis.

Ein weiterer Browserlauf legt mit Franks delegiertem Anlegerecht eine Buchung
an. John kann sie über die andere API-Instanz lesen. Nach dem Entzug darf Frank
keine neue Buchung beginnen, die vorhandene Buchung aber weiterhin öffnen und
das Werkzeug auch ohne aktuelle Preisfreigabe zurückgeben.

Bei einer Ausgabe werden die aktive Buchung des Werkzeugs und der neue
Buchungsdatensatz gemeinsam veröffentlicht. Das gilt auch für die gesamte
Auswahl im Sammeldialog: Fehlt bei einem Werkzeug oder im betroffenen Projekt
ein Schreibrecht, wird keines der ausgewählten Werkzeuge umgebucht. Wurde eine
Buchung seit der Auswahl verändert, bleibt die Auswahl mit einer Fehlermeldung
offen. Die betreffende Auswahl lässt sich anschließend aktualisieren.
Bei einer kleinen Auswahl fragt der Browser die Zugriffsrechte für die
betroffenen Werkzeuge, bisherigen Buchungen und neuen Buchungsbereiche gemeinsam
ab. Bei einem Verbindungsabbruch ruft er gezielt den Bereich mit der
unveränderlichen Bestätigung ab.

Eine Umbuchung beendet die alte Buchung, legt eine Fortsetzung an und übernimmt
die aktuellen Nutzungskosten.
Die Kosten der vorherigen Buchung bleiben erhalten. Rückgabe und Ablehnung
offener Umbuchungsanfragen erfolgen ebenfalls gemeinsam. Eine Rückgabe benötigt
keinen Kostenschlüssel.

Bei einer neuen Ausgabe an ein registriertes Mitglied erzeugt der Browser ein
Signaturschlüsselpaar für genau diese Buchung. Den privaten Teil versiegelt er
für das zuständige Mitglied und die Mandantenwiederherstellung. Werkzeugstatus
und Projektkosten enthalten in ihren verschlüsselten Daten nur den Prüfschlüssel.
Die API erhält dessen Prüfsumme und bindet sie an die signierte Buchungsrevision.
Ein späterer Schreibvorgang darf diese Zuordnung weder austauschen noch entfernen.
Der Mehrinstanztest prüft diese Bindung und die getrennte Ablage in den drei
Bereichen. Browser und API können einen mit diesem Schlüssel signierten
Rückgabenachweis prüfen. Er gilt für genau einen Mandanten und eine
Buchungsrevision. Ein gültiger Nachweis beendet das aus der Ausgabe abgeleitete
Leserecht. Andere Freigaben folgen weiterhin den Berechtigungsregeln. Die
Rückgabe durch den Verantwortlichen wird erst verfügbar, wenn die API den Befehl
transaktional annimmt und Werkzeugstatus, Umbuchungen und Projektkosten ihn
berücksichtigen.

Die Rückgabe aus der Werkzeugansicht gilt für die dort angezeigte Buchung.
Wurde das Werkzeug zwischenzeitlich erneut ausgegeben, lässt die alte Aktion
die neue Buchung bestehen. Wer die frühere Buchung selbst abgeschlossen hat,
kann dieselbe Aktion nach einer unterbrochenen Verbindung wiederholen. Dabei
kann der Browser einen ausstehenden Schlüsselwechsel fortsetzen.

Im Browsertest gibt eine Person ohne globale Administratorrolle das Werkzeug
über die Detailansicht zurück. In der zweiten Browsersitzung verschwindet die
Buchung bei der bisherigen zuständigen Person. Der zugehörige Mehrinstanztest
prüft den Schlüsselwechsel im freigegebenen Bereich. Der Bereich für
Umbuchungsanfragen bleibt bis zur Erneuerung durch einen weiteren Berechtigten
vorgemerkt. Eine Wiederholung der Rückgabe lässt eine spätere Ausgabe bestehen.

Eine verschlüsselte, unveränderliche Bestätigung bindet den ausgeführten Befehl
an dessen Urheber und vollständige Eingaben. Nach einer verlorenen Antwort wird
beim Wiederholen das ursprüngliche Ergebnis zurückgegeben. Das erzeugt auch
dann keine neue Ausgabe, wenn das Werkzeug inzwischen wieder zurückgegeben
wurde. Ein nativer Test mit zwei API-Instanzen prüft diese Wiederholung sowie
fehlende Rechte, konkurrierende Ausgaben und eine vorgetäuschte Speicherantwort.
Ein Browser-Test mit getrennten Sitzungen prüft den Konflikthinweis und den
Erhalt der gesamten Auswahl. Ein weiterer durchläuft die Freigabe und den
Entzug des Anlegerechts mit einem normalen Benutzerkonto.

Für die [Projektkosten](verschluesselte-projektkosten.md) enthalten die
Projektbereiche eine zusätzliche verschlüsselte Sicht auf ihre Werkzeugnutzung.
Buchungsdaten und historische Preise bleiben darin getrennt. Änderungen an der
ursprünglichen Buchung und dieser Sicht werden gemeinsam veröffentlicht. Eine
Kostenfreigabe für eine Baustelle öffnet dadurch keine Buchungen anderer
Projekte. Ausgabe, Rückgabe und Umbuchung benötigen die jeweils betroffenen
Schreibrechte auch im Projektbereich.

Beim Anlegen eines Mandanten kann ein geprüftes Sicherungsarchiv Werkzeugdaten,
einzelne Buchungen, Inventuren und Umbuchungsanfragen liefern. Vorhandene
identische Pakete werden wiederverwendet. Abweichende Zielinhalte werden nicht
überschrieben.
Datentypen und SQL-Bedingungen prüft der Browser anhand des gemeinsamen Schemas;
die API prüft Signaturen, Schreibrechte und technische Versionsstände.

Für vollständige Arbeitsabläufe fehlen noch folgende Anschlüsse:

- Rechte zum Rückgeben oder Umbuchen folgen noch nicht automatisch aus der
  Zuständigkeit. Fehlt der buchenden Person die Schlüsselzuständigkeit, bleibt
  der Wechsel für den jeweiligen Bereich vorgemerkt. Weitere Schreibvorgänge
  in diesem Bereich warten bis zur Schlüsselerneuerung.
- Eine neue Ausgabe und die Annahme einer Umbuchung benötigen derzeit Zugriff
  auf die Werkzeugkosten, um den historischen Kostenstand anzulegen. Eine
  Übernahme dieses Kostenstands ohne Entschlüsselung ist noch anzuschließen.
- Die gemeinsame lokale Suche unterstützt Wortpräfixe. Der vollständige
  Vergleich mit der bisherigen PostgreSQL-Textsuche steht noch aus.

Die Personalauswahl und die Namensanzeigen lesen die
[verschlüsselten Personalprofile](verschluesselte-personaldaten.md), auch für
den letzten Verantwortlichen einer Inventur. Bei einer Ausgabe oder
Umbuchungsanfrage prüft der Browser fremde Verantwortliche anhand ihres aktiven,
nicht archivierten Profils. Dessen gelesene Bereichsversion wird beim Speichern
mitgeprüft. Kosten und weitere Personalangaben werden dafür nicht entschlüsselt.

Diese offenen Anschlüsse gehören zum
[Funktionsabgleich](verschluesselung-funktionsabgleich.md). Sie werden nicht als
serverseitige Klartext-Ausnahmen behandelt.
