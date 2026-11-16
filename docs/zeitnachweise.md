# Zeitnachweise für abgeschlossene Datenstände

Ein freigegebenes Angebot oder eine Abwesenheitsentscheidung darf sich
nachträglich nicht unbemerkt ändern. sortsys trennt dafür die Bearbeitungssperre
vom externen Zeitnachweis. Die Sperre gilt bereits beim Speichern.
OpenTimestamps belegt später, dass genau dieser signierte, verschlüsselte Stand
spätestens zum Zeitpunkt eines Bitcoin-Blocks existierte.

Der erste Anschluss erfasst Abwesenheitsanträge, Entscheidungen, Rücknahmen und
endgültig gesperrte GAEB-Dokumentstände. Auch übernommene Rechnungswerte mit
Vorgangszuordnung verwenden inzwischen unveränderliche Einzelobjekte und können
einen Zeitnachweis erhalten. Empfangene Dateien, die lediglich schreibgeschützt
sind, können weiterhin eine neue empfangene Version erhalten. Sie werden deshalb
durch diesen Anschluss nicht zusätzlich gesperrt. Entwürfe bekommen keinen
Abschlussnachweis. Weitere unveränderliche Fachvorgänge müssen beim jeweiligen
Speicherpfad angeschlossen werden.

## Arbeiten während eines Ausfalls

Die API legt den Nachweisauftrag in derselben Datenbanktransaktion wie den
unveränderlichen Datenstand an. Die eigentliche Kalenderanfrage folgt danach im
Browser. Ohne Beleg bleibt der Vorgang gespeichert und gesperrt. Ein Ausfall von
OpenTimestamps blockiert weder das Arbeiten noch das Abschließen weiterer
Vorgänge.

Ein angemeldeter Browser holt ausstehende Belege automatisch nach.
Dokumentänderungen wecken die Verarbeitung; ohne solche Ereignisse prüft sie
höchstens alle 15 Minuten auf fällige Aufträge. Nach einem Kalenderausfall
verzögert die gemeinsame Warteschlange weitere Versuche. Geschlossene Browser
führen keine Kalenderanfragen aus; beim nächsten Öffnen wird die Verarbeitung
fortgesetzt.

Mehrere API-Instanzen teilen sich die Warteschlange in der
DuckDB-Mandantendatei. Eine Versionsprüfung reserviert einen Auftrag für zwei
Minuten. Zwei Browser können dadurch nicht gleichzeitig dieselbe gültige
Reservierung erhalten. Nach einem Abbruch läuft sie aus und ein anderer Browser
kann die Arbeit übernehmen. Dieser Zustand gehört zur Zustellung des Nachweises
und ändert keine Fachrechte.

Bei unveränderlichen Einzelobjekten folgt der Zugriff auf Beleg und Auftrag der
konkreten Inhaltsfreigabe. Beispielsweise reicht die Freigabe von
Projektgrunddaten nicht für einen Rechnungswert. Die Reservierung gleicht
deshalb sowohl den Bereich als auch die Belegart ab; ein Benutzer kann keine
vertraulichen Aufträge einer anderen Feldfreigabe übernehmen.

## Was unveränderlich bleibt

Der Nachweis bezieht sich auf den vollständigen signierten
Verschlüsselungsrahmen, einschließlich Signatur, Datenstand und
Berechtigungskontext. Die API bewahrt den ursprünglichen verschlüsselten Beleg
auf. Eine Rücknahme eines Antrags bekommt einen eigenen Nachweis; sie
überschreibt weder den ursprünglichen Antrag noch eine bereits vorhandene
Entscheidung.

Datenstand, Nachweise und Warteschlange liegen in getrennten Datensatzgruppen
derselben Mandantendatei. Neue `.ots`-Belege werden angehängt; ein Upgrade
ergänzt frühere Kalenderbelege. Die API bietet weder das Löschen eines
Nachweises noch das Entsperren über dessen Zeitstempel an. Ein `null` beim
Abschluss eines Zustellversuchs plant ausschließlich einen neuen Versuch.
Vorhandene Belege und der ursprüngliche signierte Stand bleiben dabei erhalten.

Ein Datenbankbetreiber kann gespeicherte Belege trotzdem unterdrücken.
OpenTimestamps verhindert solche Eingriffe nicht physisch. Gegen einen bereits
unabhängig aufbewahrten Beleg lässt sich ein anderer Datenstand jedoch nicht als
derselbe nachgewiesene Stand ausgeben. Wenn der Betreiber alle Kopien
zurückhält, kann ein neues Gerät das frühere Vorliegen nicht allein aus einer
leeren Antwort beweisen. Für diese Prüfung sollten die heruntergeladenen
Nachweispakete außerhalb der sortsys-Instanz aufbewahrt werden.

## Prüfung und Download

Bei abgeschlossenen Dokumenten und Abwesenheiten öffnet **Zeitnachweis** den
Prüfstand. „Beim Kalender eingereicht“ bedeutet noch keinen bestätigten
Bitcoin-Nachweis. Die Browserprüfung berechnet den vollständigen Commitment-Pfad
und vergleicht dessen Merkle-Wurzel mit dem Block an der angegebenen Höhe.

Die eingebaute Blockauskunft fragt Blockstream und mempool.space unabhängig ab.
Beide müssen denselben Block bestätigen; mindestens sechs Bestätigungen werden
verlangt. Der Browser kontrolliert auch den Hash des gelieferten Block-Headers.
Diese Prüfung vertraut der übereinstimmenden Auskunft beider Dienste zur
gültigen Kette. Sie ersetzt keinen eigenen Bitcoin-Knoten und keine vollständige
Kettenprüfung. Bei einem Ausfall oder Widerspruch erscheint der Nachweis als
unbestätigt, niemals als erfolgreich geprüft.

Der Download enthält je Datenstand den signierten Rahmen als
`signed-packet.bin`, den Standardbeleg `signed-packet.bin.ots`, soweit
vorhanden, sowie die Zuordnung und das verschlüsselte Original als JSON. Ein
unabhängiger OpenTimestamps-Client kann die `.bin`-Datei zusammen mit ihrer
`.ots`-Datei prüfen. Der Nachweis enthält keinen Beweis für die fachliche
Richtigkeit, die Echtheit einer behaupteten Erstellungszeit oder einen früheren
Eingang bei sortsys. Für übernommene Altdaten kann erst ab der tatsächlichen
Einreichung ein externer Zeitnachweis entstehen.

## Datenübermittlung und Grenzen

Die Webapp prüft zuerst die Originalsignatur gegen die bereits vertraute
Mandantenhistorie und bindet den Beleg an den angefragten Vorgang und
Datenstand. Ein gültiger Nachweis eines anderen Vorgangs wird zurückgewiesen. An
die Kalender geht anschließend nur ein mit einer zufälligen Nonce verdecktes
SHA-256-Commitment. Klartext, Mandantenkennung, Objektkennung und Signatur
werden nicht übertragen. Die Kalender sehen weiterhin die IP-Adresse und den
Anfragezeitpunkt. Die Blockdienste erhalten ausschließlich öffentliche
Blockhöhen und Block-Hashes.

Eingebettete Kalenderadressen sind unvertraute Belegdaten. Die Webapp fragt nur
fest hinterlegte Kalender über HTTPS ab, sendet keine Zugangsdaten und folgt
keinen Weiterleitungen. Beleggröße, Pfadlänge, Verzweigungen und externe
Abfragen sind begrenzt. Pro Datenstand werden höchstens 32 unterschiedliche
Belege mit jeweils höchstens 256 KiB gespeichert. Diese Grenze beschränkt das
Nachholen, hebt aber keine bestehende Bearbeitungssperre oder frühere Beweise
auf.

Die Protokolltests vergleichen acht öffentliche Beispiele mit dem offiziellen
OpenTimestamps-Client. Weitere Tests prüfen falsche Hashwerte, beschädigte
Belege, Kalenderausfälle, Abbrüche, Upgrades und die beiden Blockauskünfte. Der
Browserlauf prüft zusätzlich den Download des tatsächlichen signierten Rahmens.
Der [native Mehrinstanztest](development.md#native-tests-ohne-entwicklungsstack)
verbindet den Webapp-Code mit zwei unabhängigen API-Zuständen und dem
gemeinsamen DuckDB-Dienst. Er prüft konkurrierende Reservierungen, die Ablehnung
eines fremden Hashwerts und das Nachholen mit einer neuen Browser-Sitzung nach
Ablauf einer Reservierung. Ein erneuter Versuch ohne neuen Beleg erhält den
früheren Nachweis. Die Kalenderantworten stammen aus synthetischen Testbelegen;
echte Kalender werden bei diesem Lauf nicht kontaktiert.

Ein weiterer Prüfschritt entfernt sämtliche optionalen Nachweisdaten aus der
vorübergehenden Testdatei. Überschreiben und Entsperren der ursprünglichen
Datenstände bleiben trotzdem ausgeschlossen. Die fachlichen Abwesenheitsadapter
werden noch auf den eigenständigen Speicher umgestellt; der gesamte
Anwendungsstart ist deshalb noch nicht PostgreSQL-frei.

Protokoll und unabhängige Prüfwerkzeuge:
[OpenTimestamps](https://opentimestamps.org/),
[JavaScript-Referenz](https://github.com/opentimestamps/javascript-opentimestamps),
[Prüfclient](https://github.com/opentimestamps/opentimestamps-client),
[Blockauskunft über Esplora](https://github.com/Blockstream/esplora/blob/master/API.md).
