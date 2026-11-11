# Einladungen zum verschlüsselten Arbeitsbereich

Eine Einladung verbindet ein vorhandenes Benutzerkonto mit der Organisation.
Die Freigabe umfasst derzeit Produktkatalog, Kunden, Ansprechpartner,
Lieferanten, Preisaufzeichnungen und persönlichen KI-Verlauf. Für die fünf
Fachdatenbereiche stehen Lesen und Bearbeiten getrennt zur Auswahl. Lieferanten
und Preise verwenden voneinander unabhängige Schlüssel; eine reine
Preisfreigabe öffnet keine Produkt- oder Lieferantenbeschreibungen.
Für bestätigte Konten lassen sich außerdem
[einzelne Projekte freigeben](verschluesselte-projekte.md).

Bei der ersten Annahme wird ein Passwort festgelegt. Der Browser erstellt damit
die OPAQUE-Registrierung und verschlüsselt die privaten Kontoschlüssel. Dieser
Weg funktioniert auch nach der Bestandsumstellung; das Passwort wird nicht an
den bisherigen Anmelde-Endpunkt gesendet. Ein bereits geschütztes Konto meldet
sich mit seinem vorhandenen Passwort an. Eine Einladung kann dessen Passwort
oder Kontotresor nicht ersetzen.

Im Tab **Datenschutz** unter **Verwaltung → Organisation** wird das Konto
ausgewählt. Nach Auswahl der zusätzlichen Berechtigungen entsteht ein
Einladungslink. Er ist sechs Tage gültig und lässt sich bis zur Freigabe
zurückziehen. Die bereits umgestellten Menüs verwenden die verifizierten
Inhaltsfreigaben. Weitere Fachbereiche benötigen bis zu ihrem Anschluss noch
die bisherigen Menürollen; eine Einladung ändert diese Rollen nicht.
Ein bereits bestehender Zugriff wird durch eine Einladung nicht entzogen.

Der Empfänger öffnet den Link. Die Webapp prüft zunächst dessen Signatur und
Vertrauensanker. Anschließend erscheint das Formular zum Festlegen des Passworts
oder zur Anmeldung mit dem vorhandenen Konto. Die Webapp bestätigt die Einladung und wartet auf die Freigabe durch den
Organisationsadministrator. Dieser lädt die Liste neu und wählt **Zugang
freigeben**. Erst nach Bereitstellung aller vorgesehenen Datenbereiche ist der
Zugang fertig. Bei einer unterbrochenen Freigabe lässt sich dieser Schritt
erneut ausführen.

## Weshalb der Link ein Geheimnis enthält

Ein öffentlicher Schlüssel aus der Datenbank beweist noch nicht, wem er gehört.
Ein Betreiber mit Schreibzugriff könnte dort einen anderen Schlüssel ablegen.
Die Einladung enthält deshalb ein zufälliges Geheimnis im URL-Fragment. Dieses
Fragment wird bei einem normalen Seitenaufruf nicht an den Webserver übertragen.
Die Einladungsseite entfernt es nach dem Öffnen aus der sichtbaren Adresse.

Der Browser des Empfängers bestätigt seine öffentlichen Schlüssel mit diesem
Geheimnis. Die Bestätigung bindet außerdem Benutzerkonto, Mandant,
Kontofassung und Wiederherstellungsgeneration. Der einladende Browser prüft sie,
bevor er die Identität bestätigt. Das Geheimnis liegt bei ihm ausschließlich in
einem verschlüsselten persönlichen Datensatz. Die API erhält öffentliche
Nachweise, aber weder das Geheimnis noch private Kontoschlüssel. Ein zusätzlicher
Kontonachweis bindet die erste Registrierung an den verschlüsselten Kontotresor
und den OPAQUE-Eintrag. Ein abgefangener Einladungsnachweis lässt sich damit
nicht mit einem anderen Passwort oder Tresor wiederverwenden.

Der Link ist damit eine Zugangsberechtigung und sollte nur an den vorgesehenen
Empfänger weitergegeben werden. Der Browser-Code bleibt wie im übrigen Modell
eine Vertrauensstelle. Ein Betreiber, der diesen Code austauscht, könnte auch
Einladungsgeheimnisse abgreifen.

## Getrennte Datenfreigaben

Nach der Bestätigung stellt der Administrator die nötigen Bereichsschlüssel
für die bestätigten öffentlichen Schlüssel bereit. Dabei werden alle noch
verwendeten Schlüsselgenerationen berücksichtigt. Ein Katalog mit älteren und
neueren Einträgen bleibt dadurch vollständig lesbar. Die API prüft Signaturen,
Berechtigungen und Fassungen; sie entschlüsselt keine Inhalte.

Für den persönlichen KI-Verlauf entsteht ein eigener Bereich. Seine
Schlüsselhülle ist für das eingeladene Konto bestimmt. Das einladende
Administratorkonto erhält dadurch keinen Leseschlüssel für diesen Verlauf.
Die Wiederherstellungsphrase deckt diesen Bereich wie die anderen
Mandantendaten ab.

Identitätsbestätigung und fertiger Zugang sind getrennte Zustände. Fehlt nach
einem Verbindungsabbruch noch eine Schlüsselhülle, meldet die Oberfläche keinen
fertigen Zugang. Derselbe Freigabevorgang kann fortgesetzt werden. Die API
koordiniert diese Zustände über Datenbanktransaktionen, auch bei Anfragen an
verschiedene Instanzen.

## Bestehenden Zugang ändern

Bei einem bereits bestätigten Konto zeigt dieselbe Auswahl dessen aktuelle
Freigaben. **Berechtigungen speichern** ändert die Zugriffe auf Produktkatalog,
Kunden, Ansprechpartner, Lieferanten, Preisaufzeichnungen und persönlichen KI-Verlauf. Nicht bearbeitete
Bereiche behalten ihre bisherigen Regeln, einschließlich individueller
Schreibrechte und ausdrücklicher Verbote.

Unter **Anlageberechtigungen** lassen sich **Neue Projekte anlegen** und
**Neue Angebote und Aufträge anlegen** unabhängig freigeben. Ein neuer
kaufmännischer Bereich braucht kein vorab angelegtes Projekt. Die signierte
Freigabe nennt die berechtigten Ersteller und die verpflichtenden Empfänger;
der private Mandantenschlüssel wird nicht weitergegeben. Ein Entzug verhindert
weitere Anlagen und ändert keine bestehenden Einzelfreigaben.

Der Abschnitt **Projektzugriff** verwaltet Grunddaten, Dateien, Auftragswerte,
Beschaffung und Lieferscheinmengen unabhängig je Projekt. Die
[Projektbeschreibung](verschluesselte-projekte.md) erklärt die Anlageberechtigung;
die [Dateiablage](verschluesselte-projektdateien.md) beschreibt den Schutz der
Originale und Vorschauen. Für [Lieferscheine](verschluesselte-lieferscheine.md)
öffnen Mengenrechte keine Sonderpostenpreise.

Ändert sich der Leserkreis eines vorhandenen Bereichs, bleibt das Schreiben dort
bis zum fertigen Schlüsselwechsel gesperrt. Der Browser erstellt einen neuen
Schlüssel und verteilt ihn ausschließlich an die weiterhin berechtigten
Identitäten. Ohne gewöhnliche Leser erhält nur die Wiederherstellungsphrase ein
neues Schlüsselpaket. Der Administrator bekommt dadurch keinen Zugriff auf den
persönlichen Verlauf anderer Benutzer.

Eine Unterbrechung verliert diesen Auftrag nicht. **Aktualisieren** oder das
erneute Öffnen der Verwaltung setzt ihn mit den aktuellen signierten Regeln
fort. Dafür muss ein berechtigter Administrator im Browser angemeldet sein;
die API kann diesen Schritt ohne private Schlüssel nicht selbst ausführen.
Eine verlorene Antwort wird anhand der gespeicherten signierten Freigabe
geprüft.

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

## Verbleibender Umbau

Derzeit kann das Konto verwalten, das die Organisation eingerichtet oder zuletzt
wiederhergestellt hat. Weitere Administratoren brauchen noch eine delegierte
Verwaltungsfreigabe. Andere Fachbereiche müssen an dieselbe Rechteverwaltung
angeschlossen werden. Eine neue Wiederherstellungsgeneration macht alte
Einladungen ungültig.

Die vollständige Bestandsumstellung bleibt bis zum Anschluss der übrigen
Fachbereiche gesperrt. Die Benutzerverwaltung hebt diese Sperre nicht auf.
Bei kaufmännischen Vorgängen sind Listen, neue Entwürfe und Änderungen der
Grunddaten mit den getrennten Inhaltsbereichen verbunden. Ein Mitarbeiter kann
eine Bezeichnung ändern, ohne dafür Preise oder interne Notizen lesen zu müssen.
Öffnen, Speichern und Phasenwechsel sind angeschlossen. Im Editor fehlen noch
gesperrte Felder für Teilfreigaben; auch die Abrechnung braucht weitere Anschlüsse. Der
[Vorgangsadapter](verschluesselte-vorgaenge.md) beschreibt den genauen Umfang.
