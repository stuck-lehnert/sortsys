# Rechnungen und Zahlungseingänge mit verschlüsselten Daten

Ein angenommener Auftrag lässt sich als Rechnung abrechnen oder zunächst über
Abschlagsrechnungen. Nach ausgestellten Abschlägen schließt eine Schlussrechnung
den Auftrag ab. Sie zieht die bereits berechneten Nettobeträge und die
zugehörige, gerundete Umsatzsteuer ab. Pauschale Abschläge bleiben ebenfalls
möglich.

Die vorhandenen Formulare und der GAEB-Editor verwenden dafür den
verschlüsselten Browseradapter. X89-Entwürfe bleiben direkt bearbeitbar. Mengen,
Einheitspreise, Nachlässe, Einzelbeträge und Steuer werden mit Dezimalarithmetik
geprüft. Bei vollständig lesbaren Dokumenten prüft der XML-Worker zusätzlich das
GAEB-Schema. Teilansichten bewahren ungelesene Inhalte und prüfen Änderungen
gegen deren signierte Verweise. Einen vollständigen Schemanachweis liefert diese
Prüfung nicht. Die API erhält dabei keinen Rechnungstext und keine
unverschlüsselten Beträge.

## Eine Rechnung ausstellen

„Rechnung ausstellen“ vergibt die Nummer und schreibt die Rechnung fest. In
einem gemeinsamen Speichervorgang werden das nummerierte XML gesperrt, die
Abrechnungswerte unveränderlich abgelegt, der Auftrag aktualisiert und der
Rechnungswert im Projekt gebucht. Eine zweite API-Instanz kann auf demselben
Ausgangsstand keine konkurrierende Nummernvergabe abschließen. Nach einem
Versionskonflikt muss der Client den aktuellen Stand verwenden.

Die Nummer folgt dem Schema aus Verwaltung → Organisation. Zähler und belegte
Nummern liegen verschlüsselt vor. Ein unveränderlicher geheimer Namensraum
bestimmt die technischen Belegungskennungen; die API sieht an ihnen weder Nummer
noch Rechnungsdatum. Ein zurückgesetzter Zähler genügt nicht, um eine bereits
belegte Nummer erneut zu vergeben. Die Belegungen werden beim nächsten Versuch
weiterhin geprüft.

Die Dokumentensperre und die unveränderlichen Datensätze gelten unabhängig von
[OpenTimestamps](zeitnachweise.md). Ein fehlender oder später ergänzter
Zeitnachweis öffnet keine ausgestellte Rechnung zur Bearbeitung.

## Zahlungen und Berechtigungen

Zahlungen werden als weitere unveränderliche Datensätze erfasst. Der gelesene
Zahlungsstand bestimmt den offenen Betrag und den Status „teilweise bezahlt“
beziehungsweise „bezahlt“. Eine wiederholte Übermittlung derselben Zahlung
behält ihre Kennung und erzeugt keine Doppelbuchung. Gleichzeitige Zahlungen
werden gegen denselben Abrechnungsstand geprüft; zusammen können sie den offenen
Betrag nicht übersteigen. Die Signatur muss zum angegebenen Zahlungserfasser
gehören.

Grunddaten, Rechnungsinhalte und Projektkosten besitzen getrennte Freigaben. Der
Abrechnungsbereich des angenommenen Auftrags enthält die zugehörigen
Rechnungsbeträge auch dann, wenn einzelne untergeordnete Vorgänge nicht lesbar
sind. Damit beruht eine Schlussrechnung auf der vollständigen Abschlagskette.
Die Freigabe dieses Bereichs erlaubt folglich Einsicht in diese Auftragssummen.

Ein Rechnungsentwurf kann auch ohne Zugriff auf unbekannte XML-Erweiterungen
bearbeitet werden. Dazu braucht das Konto die Rechnungswerte und Leserechte auf
Grunddaten und Abrechnung des Auftrags. Schreibrechte auf Beschreibung,
Stammdaten oder Nummernvergabe sind für eine reine Preisänderung nicht nötig.
Ohne lesbaren Auftragszusammenhang bleiben die Rechnungswerte sichtbar, aber
schreibgeschützt. Das Ausstellen verlangt weiterhin die zusätzlichen Freigaben
für Nummernvergabe und Projektbuchung. Dafür muss nicht jede XML-Erweiterung
lesbar sein: Beim Nummerieren ändert der Browser nur den Abrechnungsbereich und
übernimmt die signierten Verweise der übrigen Inhalte unverändert in die
Dokumentensperre. Beträge, Steuer, Anschriften und Rechnungsstruktur werden im
lesbaren Teil geprüft; die vollständige XSD-Prüfung bleibt auf vollständig
lesbare Dokumente beschränkt.

Die Benutzerverwaltung vergibt Rechnungsnummern gesondert. Diese Freigabe öffnet
die mandantenweiten Zähler und Nummernbelegungen, einschließlich ihrer
Vorgangszuordnungen. Sie gewährt keine Kalkulationspreise anderer Projekte und
keine Schreibrechte auf das Nummernschema der Organisation. Für das Ausstellen
bleiben die passenden Vorgangs- und Projektfreigaben erforderlich.

## Prüfstand und verbleibende Grenzen

Der [native Abrechnungstest](../sortsys-webapp-v2/scripts/test-live-billing.ts)
verwendet zwei unabhängige API-Prozesse und den regulären Browseradapter mit
lokalem DuckDB und XML-WASM. Geprüft sind bearbeitbare Entwürfe, verlorene
Bestätigungen bei der Ausstellung und bei Zahlungen, gleichzeitig vorbereitete
Freigaben, überhöhte Zahlungen und die Schlussabrechnung mehrerer Abschläge. Der
gemeinsame Lauf öffnet eine vollständig bezahlte Rechnung nach zwei
aufeinanderfolgenden Seed-Recoveries erneut. Die API-Anfragen enthalten dabei
keine Rechnungstexte oder Zahlungsreferenzen im Klartext.

Der [Bestandstest](../sortsys-webapp-v2/scripts/test-live-billing-migration.ts)
übernimmt vorhandene Rechnungen, Abschläge, einen Schlussrechnungsentwurf,
Zahlungen und Nummernzähler. Die XML-Originale bleiben bytegenau erhalten,
einschließlich BOM und Zeilenenden. Historische Zahlungserfasser bleiben von der
Person unterschieden, die den Bestand verschlüsselt. Ein Abbruch nach der ersten
festgeschriebenen Rechnung lässt sich fortsetzen; eine abgeschlossene Übernahme
erzeugt beim Wiederholen keine weiteren Schreibvorgänge. Weitere Zahlungen und
die Ausstellung des übernommenen Entwurfs sind ebenfalls geprüft. Der Test
stellt Originaldateien über einen eigenen schreibgeschützten HTTP-Dienst bereit;
er prüft keine vollständige S3-Implementierung.

Der
[Mitarbeitertest](../sortsys-webapp-v2/scripts/test-live-billing-permissions.ts)
verwendet ein regulär eingeladenes Konto ohne Verwaltungsrolle. Er prüft die
getrennten Freigaben für Rechnung, Auftrag, Projektbuchung und Nummernvergabe.
Ohne eine erforderliche Freigabe bleibt die Rechnung unverändert. Nach
Rechteentzug sind neue Zahlungsstände verborgen; eine erneute Lesefreigabe
erlaubt noch keine weitere Zahlung. Dafür genügen gesonderte Anlege- und
Auftragsrechte, ohne Schreibrecht auf das Nummernschema oder bestehende
Projektbuchungen. Die Aktionsfreigaben der Oberfläche sind zusätzlich über
[gemeinsame Berechtigungsfunktionen](../sortsys-webapp-v2/app/lib/crypto/invoiceAccess.ts)
mit Modultests abgesichert. Der Ablauf `billing-actions-between-users` im
[Oberflächentest](../sortsys-webapp-v2/scripts/e2e/development.browser.mjs)
prüft diese Rechnungsaktionen mit einem Mitarbeiterkonto. Zwei Browserkontexte
verwenden verschiedene API-Instanzen. Geprüft
werden die einzelnen Freigaben, das Ausstellen einer Teilansicht, eine abgewiesene
Überzahlung und eine gültige Zahlung. Nach Rechteentzug schließt sich die
Zahlungsansicht; eine erneute Lesefreigabe erlaubt nach dem Öffnen des Links nur
die Einsicht. Beim Erstladen und bei kryptografischen Veröffentlichungen wartet
der Test jeweils bis zu einer Minute. Er misst keine Ladezeiten.

Die allgemeine Mandantenumstellung bleibt bis zum Abschluss der übrigen
Fachbereiche gesperrt.

Die API kann Versionen, technische Eindeutigkeit, Signaturen und Schreibrechte
erzwingen. Die fachliche Richtigkeit geheimer Beträge bleibt eine
[Clientprüfung](verschluesselung-datenpruefung.md). Ein berechtigter,
absichtlich veränderter Client kann diese Prüfungen umgehen; daraus entsteht
keine serverseitige Garantie für Steuerberechnung oder Vollständigkeit der
Rechnung.
