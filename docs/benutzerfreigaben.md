# Einladungen zum verschlüsselten Arbeitsbereich

Neue Benutzer lassen sich im Abschnitt **Benutzerzugang** unter **Verwaltung →
Organisation → Datenschutz** anlegen. **Benutzer anlegen** öffnet das gewohnte
Profilformular. Nach dem Speichern ist das neue Konto für eine Einladung
ausgewählt. Das Anlegen vergibt noch kein Passwort und keinen Inhaltszugriff.
Name, Kontaktdaten, Urlaubsanspruch und Stundensatz werden im Browser
verschlüsselt. Die API speichert die technischen Kontodaten und einen signierten
Anlagenachweis. Die persönlichen Profilfelder erhält sie verschlüsselt.

Eine Einladung verbindet das Benutzerkonto anschließend mit der Organisation.
Die Freigabe umfasst derzeit Produktkatalog, Kunden, Ansprechpartner,
Lieferanten, Preisaufzeichnungen sowie **KI-Assistent und persönlicher
Verlauf**. Für die fünf Fachdatenbereiche stehen feste Profile und eine Auswahl
**Individuell** bereit. Damit lassen sich Lesen, Anlegen, Bearbeiten und Löschen
einzeln erlauben. Lieferanten und Preise verwenden voneinander unabhängige
Schlüssel; eine reine Preisfreigabe öffnet keine Produkt- oder
Lieferantenbeschreibungen. Für bestätigte Konten lassen sich außerdem
[einzelne Projekte freigeben](verschluesselte-projekte.md) und
[Personaldaten getrennt von internen Stundensätzen öffnen](verschluesselte-personaldaten.md).

Für bestätigte Konten steht außerdem eine eigene **Skriptfreigabe** bereit. Sie
erlaubt beispielsweise das Lesen und Ausführen vorhandener Client-Skripte, ohne
deren Bearbeitung zuzulassen. Anlegen, Bearbeiten und Löschen lassen sich
einzeln vergeben. Der Zugriff auf die Unternehmensanschrift öffnet diesen
Bereich nicht. Ein ausgeführtes Skript verwendet weiterhin die Datenfreigaben
des angemeldeten Kontos.

Bei der ersten Annahme wird ein Passwort festgelegt. Der Browser erstellt damit
die OPAQUE-Registrierung und verschlüsselt die privaten Kontoschlüssel. Das
Passwort bleibt im Browser. Ein bereits geschütztes Konto meldet sich mit seinem
vorhandenen Passwort an. Eine Einladung kann dessen Passwort oder Kontotresor
nicht ersetzen.

Im Tab **Datenschutz** unter **Verwaltung → Organisation** wird das Konto
ausgewählt. Nach Auswahl der zusätzlichen Berechtigungen entsteht ein
Einladungslink. Er ist sechs Tage gültig und lässt sich bis zur Freigabe
zurückziehen. Die Menüs verwenden die verifizierten Inhaltsfreigaben. Ein
bereits bestehender Zugriff wird durch eine Einladung nicht entzogen.

Der normale Namenszugriff umfasst aktive Personalprofile. Einladungen erhalten
deren Stammdatenschlüssel; neu angelegte Profile werden den bereits bestätigten
Namenslesern ebenfalls bereitgestellt. Ausdrückliche Verbote bleiben erhalten.
Die Bereiche für Personalangaben und interne Stundensätze bleiben getrennt.

Der Empfänger öffnet den Link. Die Webapp prüft zunächst dessen Signatur und
Vertrauensanker. Anschließend erscheint das Formular zum Festlegen des Passworts
oder zur Anmeldung mit dem vorhandenen Konto. Die Webapp bestätigt die Einladung
und wartet auf die Freigabe durch den Organisationsadministrator. Dieser lädt
die Liste neu und wählt **Zugang freigeben**. Erst nach Bereitstellung aller
vorgesehenen Datenbereiche ist der Zugang fertig. Bei einer unterbrochenen
Freigabe lässt sich dieser Schritt erneut ausführen.

## Weshalb der Link ein Geheimnis enthält

Ein öffentlicher Schlüssel aus der Datenbank beweist noch nicht, wem er gehört.
Ein Betreiber mit Schreibzugriff könnte dort einen anderen Schlüssel ablegen.
Die Einladung enthält deshalb ein zufälliges Geheimnis im URL-Fragment. Dieses
Fragment wird bei einem normalen Seitenaufruf nicht an den Webserver übertragen.
Die Einladungsseite entfernt es nach dem Öffnen aus der sichtbaren Adresse.

Der Browser des Empfängers bestätigt seine öffentlichen Schlüssel mit diesem
Geheimnis. Die Bestätigung bindet außerdem Benutzerkonto, Mandant, Kontofassung
und Wiederherstellungsgeneration. Der einladende Browser prüft sie, bevor er die
Identität bestätigt. Das Geheimnis liegt bei ihm ausschließlich in einem
verschlüsselten persönlichen Datensatz. Die API erhält öffentliche Nachweise,
aber weder das Geheimnis noch private Kontoschlüssel. Ein zusätzlicher
Kontonachweis bindet die erste Registrierung an den verschlüsselten Kontotresor
und den OPAQUE-Eintrag. Ein abgefangener Einladungsnachweis lässt sich damit
nicht mit einem anderen Passwort oder Tresor wiederverwenden.

Der Link ist damit eine Zugangsberechtigung und sollte nur an den vorgesehenen
Empfänger weitergegeben werden. Der Browser-Code bleibt wie im übrigen Modell
eine Vertrauensstelle. Ein Betreiber, der diesen Code austauscht, könnte auch
Einladungsgeheimnisse abgreifen.

## Getrennte Datenfreigaben

Nach der Bestätigung stellt der Administrator die nötigen Bereichsschlüssel für
die bestätigten öffentlichen Schlüssel bereit. Dabei werden alle noch
verwendeten Schlüsselgenerationen berücksichtigt. Ein Katalog mit älteren und
neueren Einträgen bleibt dadurch vollständig lesbar. Die API prüft Signaturen,
Berechtigungen und Fassungen; sie entschlüsselt keine Inhalte.

Für den persönlichen KI-Verlauf entsteht ein eigener Bereich. Seine
Schlüsselhülle ist für das eingeladene Konto bestimmt. Das einladende
Administratorkonto erhält dadurch keinen Leseschlüssel für diesen Verlauf. Die
Wiederherstellungsphrase deckt diesen Bereich wie die anderen Mandantendaten ab.

Die Freigabe für den Assistenten erlaubt auch dessen Nutzung. Dazu werden Lesen,
Anlegen und Bearbeiten im persönlichen Bereich geprüft. Eine zusätzliche
LLM-Rolle ist dafür nicht erforderlich. Die fachlichen Rechte bleiben getrennt:
Ein Mitarbeiter kann beispielsweise chatten, ohne Katalog- oder Preisschlüssel
zu erhalten. Für das Einlesen mit Produktsuche wird zusätzlich Katalogzugriff
benötigt.

Wird die Assistentenfreigabe entzogen, beendet die API auch eine bereits
laufende Anfrage. Das funktioniert über verschiedene API-Instanzen und hängt
nicht davon ab, ob die Oberfläche ihre Verbindung freiwillig schließt. Eine
spätere Freigabe macht den vorhandenen verschlüsselten Verlauf wieder
zugänglich.

Identitätsbestätigung und fertiger Zugang sind getrennte Zustände. Fehlt nach
einem Verbindungsabbruch noch eine Schlüsselhülle, meldet die Oberfläche keinen
fertigen Zugang. Derselbe Freigabevorgang kann fortgesetzt werden. Die API
koordiniert diese Zustände über Datenbanktransaktionen, auch bei Anfragen an
verschiedene Instanzen.

## Bestehenden Zugang ändern

Bei einem bereits bestätigten Konto zeigt dieselbe Auswahl dessen aktuelle
Freigaben. **Berechtigungen speichern** ändert die Zugriffe auf Produktkatalog,
Kunden, Ansprechpartner, Lieferanten, Preisaufzeichnungen und persönlichen
KI-Verlauf. Nicht bearbeitete Bereiche behalten ihre bisherigen Regeln,
einschließlich individueller Schreibrechte und ausdrücklicher Verbote. Ein
einzelnes Häkchen ändert nur diese Aktion. Ändert eine andere Administration
währenddessen ein unberührtes Recht, bleibt deren Änderung erhalten. Mehrere
bearbeitete Bereiche werden als eine signierte Freigabe gespeichert.

Die festen Profile setzen den gesamten Aktionsumfang des Bereichs neu: **Kein
Zugriff** entfernt alle Aktionen, **Lesen** erlaubt nur das Lesen und **Lesen
und bearbeiten** umfasst auch das Anlegen und Löschen. Bereits vorhandene
zusätzliche Rechte werden bei **Individuell** angezeigt. Dort lassen sich Lesen,
Anlegen, Bearbeiten und Löschen getrennt ändern. Weitere angezeigte Aktionen
bleiben erhalten, wenn nur eines dieser Einzelrechte geändert wird.

Abwesenheitsanträge und Entscheidungen haben eigene Freigaben. Zertifizierte
Mitarbeitende können eigene Abwesenheiten beantragen; ihre Vorgesetzten dürfen
sie über alle nachgeordneten Ebenen entscheiden. Externe Kräfte, Nachunternehmer
und interne Personen ohne zuständigen Vorgesetzten erhalten die eigene
automatische Genehmigung. Ein eingestellter Standardvorgesetzter übernimmt
interne Personen ohne direkte Zuordnung. Seine eigene Zuordnung bleibt davon
ausgenommen. Ein Vorgesetztenwechsel führt diese automatischen Rechte nach und
erhält manuelle Ausnahmen. Ein gezielt gesetztes Verbot gilt weiterhin. Die
zugehörigen Personalangaben enthalten den Urlaubsanspruch, aber keine internen
Stundensätze. Die technischen Prüfungen und ihre Grenzen beschreibt der
[Abwesenheitsablauf](abwesenheiten-protokoll.md).

Unter **Anlageberechtigungen** lassen sich neue Projekte, Angebote und Aufträge
sowie Werkzeugbuchungen unabhängig freigeben. Ein neuer kaufmännischer
Bereich braucht kein vorab angelegtes Projekt. Die signierte Freigabe nennt die
berechtigten Ersteller und die verpflichtenden Empfänger; der private
Mandantenschlüssel wird nicht weitergegeben. Ein Entzug verhindert weitere
Anlagen und ändert keine bestehenden Einzelfreigaben. Mehrere geänderte
Anlegerechte werden gemeinsam signiert. Der Client liest jedes neue Zertifikat
zurück und prüft seine Signatur, bevor die Zugriffsregel es aktiviert. Eine
falsche Erfolgsantwort schaltet damit kein ungeprüftes Recht frei; ein erneuter
Versuch kann die noch offene Änderung abschließen.

Für eine Werkzeugausgabe werden zusätzlich die Schreibfreigabe des Werkzeugs
und derzeit dessen Kostenfreigabe benötigt. Das Anlegerecht allein öffnet keine
vorhandenen Werkzeuge oder Buchungen. Bei der Rückgabe wird kein Zugriff auf die
aktuellen Werkzeugpreise benötigt. Die
[Werkzeugverwaltung](verschluesselte-werkzeuge.md) beschreibt die noch fehlende
Preisübernahme ohne Entschlüsselung.

Der Abschnitt **Projektzugriff** verwaltet Grunddaten, Dateien, Auftragswerte,
Rechnungswerte und Beschaffung unabhängig je Projekt. Lieferscheine,
Bautagesberichte und Regieberichte haben eigene Bereiche. Lieferscheinpreise,
interne Arbeitskosten und Regiestunden werden jeweils separat freigegeben.
Werkzeugnutzung und Werkzeugkosten sind ebenfalls je Projekt getrennt. Die
[Kostenauswertung](verschluesselte-projektkosten.md) erklärt ihre weiteren
Voraussetzungen. Die
[Einsatzplanung und Baustellensperren](verschluesselte-einsatzplanung.md) haben
ebenfalls einen eigenen Projektbereich. Die
[Projektbeschreibung](verschluesselte-projekte.md) erklärt die
Anlageberechtigung; die [Dateiablage](verschluesselte-projektdateien.md)
beschreibt den Schutz der Originale und Vorschauen. Für
[Lieferscheine](verschluesselte-lieferscheine.md) öffnen Mengenrechte keine
Sonderpostenpreise.

Unter **Angebote und Dokumente** wird ein einzelner Vorgang ausgewählt. Seine
Bezeichnung, Leistungsbeschreibungen, Vertragsmengen, Aufmaße, Angebotspreise,
interne Kalkulation, Beschaffung, Rechnungswerte und Anlagen haben getrennte
Freigaben. Damit kann ein Mitarbeiter beispielsweise die Positionstexte eines
Angebots bearbeiten, ohne dessen Preise zu erhalten. Die Auswahl lädt nur die
geschützten Bezeichnungen; Dokumentinhalte und Kalkulationsdaten bleiben dabei
geschlossen. **Dokumentzugriff speichern** übernimmt die geänderten Einzelrechte
gemeinsam. Unveränderte Rechte bleiben auch dann erhalten, wenn ein anderer
Administrator sie zwischenzeitlich angepasst hat.

Ändert sich der Leserkreis eines vorhandenen Bereichs, bleibt das Schreiben dort
bis zum fertigen Schlüsselwechsel gesperrt. Der Browser erstellt einen neuen
Schlüssel und verteilt ihn ausschließlich an die weiterhin berechtigten
Identitäten. Ohne gewöhnliche Leser erhält nur die Wiederherstellungsphrase ein
neues Schlüsselpaket. Der Administrator bekommt dadurch keinen Zugriff auf den
persönlichen Verlauf anderer Benutzer.

Eine Unterbrechung verliert diesen Auftrag nicht. **Aktualisieren** oder das
erneute Öffnen der Verwaltung setzt ihn mit den aktuellen signierten Regeln
fort. Dafür muss ein berechtigter Administrator im Browser angemeldet sein; die
API kann diesen Schritt ohne private Schlüssel nicht selbst ausführen. Eine
verlorene Antwort wird anhand der gespeicherten signierten Freigabe geprüft.

Ein Rechteentzug kann bereits gelesene Inhalte und bekannte Schlüssel nicht
zurückholen. Neue Inhalte verwenden nach dem Wechsel einen anderen Schlüssel.
Wird der Zugang später erneut freigegeben, werden auch die benötigten älteren
Bereichsschlüssel bereitgestellt. Der Benutzer kann vorhandene Einträge wieder
lesen und im freigegebenen Umfang bearbeiten. Für diese Weitergabe benötigt das
verwaltende Konto selbst Lesezugriff auf den betreffenden Bereich.

Das gilt auch für neu freigegebene Vorgänge. Eine Lesefreigabe öffnet deren
bereits gespeicherte Inhalte und spätere Änderungen. Für die
[Positionssuche](verschluesselte-positionssuche.md) werden Grunddaten und
Leistungsumfang benötigt; eine reine Preisfreigabe öffnet keine Positionstexte.
Mengen und Preise werden für die Wiederverwendung einer Leistungsbeschreibung
nicht entschlüsselt.

## Freigaben für einen Bereich verwalten

Die Hauptadministration wählt ein bestätigtes Konto und den betreffenden
Datenbereich aus. Unter **Individuell** lässt sich neben dem Lesezugriff
**Freigaben verwalten** einschalten. Das gilt auch für einzelne Projektbereiche,
Dokumente, Personal- und Werkzeugdaten. Beim Speichern erhält das Konto einen
öffentlichen Nachweis für seine eigenen Schlüsselunterschriften. Der private
Mandantenschlüssel wird nicht weitergegeben.

Anschließend öffnet **Verwaltung → Organisation** für dieses Konto die Ansicht
**Datenfreigaben**. Dort werden ein bestätigter Empfänger und ein verwaltbarer
Bereich ausgewählt. Die Einzelrechte beschränken sich auf die eigenen
Befugnisse des Verwalters. Ein anderer Bereichsverwalter kann dessen Rechte
nicht ändern. Enthält eine Empfängerfreigabe weitergehende Rechte, bleibt sie
ebenfalls der Hauptadministration vorbehalten; ein einzelnes Häkchen darf diese
Rechte nicht beiläufig entfernen.

Empfängernamen stammen aus den freigegebenen verschlüsselten Personalprofilen.
Ohne Namensfreigabe erscheint die zertifizierte Kontokennung. Die Auswahl liest
keine technischen Rollen oder Personalangaben. Der Abruf bestätigt berechtigte
Konten in Seiten mit höchstens 64 Einträgen und prüft die Verwaltungsbefugnis bei
jeder Seite erneut. Nach Auswahl wird das aktuelle Empfängerzertifikat nochmals
mit der Vertrauenskette verglichen.

Das Speichern verwendet denselben Signatur- und Schlüsselwechsel wie die
primäre Rechteverwaltung. **Aktualisieren** setzt auch unterbrochene Wechsel
fort. Ein Entzug der Verwaltungsbefugnis sperrt die offene Ansicht über die
laufende Verbindung. Einladungen, Kontoverwaltung und Wiederherstellung stehen
in dieser Ansicht nicht zur Verfügung.

Anlegen und Freigabenverwaltung sind getrennte Befugnisse. Ein Anlagenachweis
erlaubt das Bearbeiten des neuen Projekts oder Dokuments, aber nicht das
Weitergeben von Rechten. Dafür ist eine ausdrückliche Verwaltungsfreigabe der
Hauptadministration erforderlich. Eine neue Wiederherstellungsgeneration macht
alte Einladungen ungültig.

## Verbleibender Umbau

Aktivieren, Deaktivieren, Archivieren und Entarchivieren verbinden das
verschlüsselte Personalprofil mit dem technischen Kontostatus und nötigenfalls
einer signierten Zugriffssperre. Die bisherigen Freigaben bleiben bei einer
Sperre erhalten. Die
[Personaldatenverwaltung](verschluesselte-personaldaten.md#benutzerzugänge)
beschreibt den Ablauf und seine Grenzen.

Umbenennen, Löschen, Rollenänderungen und der Passwortverlust eines einzelnen
Mitglieds benötigen noch geschützte Abläufe. Eine Einladung ersetzt kein bereits
registriertes Passwort und keinen vorhandenen Kontotresor.

Die vollständige Bestandsumstellung bleibt bis zum Anschluss der übrigen
Fachbereiche gesperrt. Die Benutzerverwaltung hebt diese Sperre nicht auf. Bei
kaufmännischen Vorgängen sind Listen, neue Entwürfe und Änderungen der
Grunddaten mit den getrennten Inhaltsbereichen verbunden. Ein Mitarbeiter kann
eine Bezeichnung ändern, ohne dafür Preise oder interne Notizen lesen zu müssen.
Öffnen, Speichern und Phasenwechsel sind angeschlossen. Im Editor fehlen noch
gesperrte Felder für Teilfreigaben; auch die Abrechnung braucht weitere
Anschlüsse. Der [Vorgangsadapter](verschluesselte-vorgaenge.md) beschreibt den
genauen Umfang.
