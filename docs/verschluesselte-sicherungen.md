# Mandantendateien sichern

Die Betreiberverwaltung zeigt unter **Datenspeicher** die registrierten
Mandanten. **Sicherungen** öffnet deren Dateikopien. Mit **Sicherung erstellen**
entsteht eine geschlossene DuckDB-Datei, während der Mandant weiterarbeiten
kann. **Herunterladen** überträgt diese Datei. Geschäftsinhalte und Anhänge
bleiben darin verschlüsselt; der Betreiber erhält dadurch keinen
Entschlüsselungsschlüssel.

Eine unterbrochene Anfrage lässt sich mit **Erneut versuchen** fortsetzen. Nach
einem Neuladen zeigt ein noch offener Auftrag stattdessen **Fortsetzen**.
Derselbe Auftrag erzeugt dieselbe Datei, auch wenn die zweite Anfrage eine
andere API-Instanz erreicht. Eine neue Sicherung benötigt einen neuen Auftrag.

Die Liste lädt jeweils höchstens 100 Einträge eines gemeinsamen Datenstands.
**Weitere Sicherungen** ruft die nächste Seite ab. Ändert sich die Liste
zwischenzeitlich, verlangt sie einen neuen Abruf, statt unterschiedliche Stände
zu vermischen. Ein globaler Betreiberzugang ist für Aufträge, Listen und
Downloads erforderlich. Mandantenadministratoren und mandantenspezifische
Betreiberzugänge können diese Infrastrukturdateien nicht lesen.

## Was zur vollständigen Wiederherstellung gehört

Eine einzelne Mandantendatei ersetzt keine vollständige Sicherung des
Datendienstes. In `control.duckdb` liegen unter anderem das Mandantenregister
und die unabhängig gespeicherten aktuellen Sicherheitsnachweise. Sie verhindern,
dass eine alte Mandantendatei eine verbrauchte Recovery-Phrase oder einen
überholten Rechtezustand reaktiviert. Das Office-Volume enthält zusätzlich
verschlüsselte Bearbeitungsstände; die [Betriebsdokumentation](deployment.md)
beschreibt diese Ablage.

Die unabhängigen Nachweise halten auch die aktuellen Schlüsselgenerationen und
Empfängerzuordnungen der Datenbereiche sowie Anlagenachweise und
delegierte Berechtigungen zum Anlegen neuer Bereiche fest. Ein früher gültiger
Zuständigkeitsnachweis darf eine bereits beendete Werkzeugbuchung dadurch nicht
wieder freigeben. Die API
vergleicht den gelesenen Bereich mit seinem geschützten Freigabestand, bevor
sie einen Schlüssel oder eine Bereichsdefinition verwendet. Der Inhaltscursor
ist davon getrennt: Gewöhnliche Dokumentänderungen schreiben ihn fort, ohne
deshalb eine neue Freigabe zu erzeugen.

Werkzeugbuchungen und ihre Kostenansätze bleiben beim Zurückspielen eines
Fachstands aktuell. Das gilt auch für abgeschlossene Buchungen und ihre
Projektkosten. Die Werkzeugkarte kann auf ihre frühere Beschreibung und
ihren früheren Standardtagessatz zurückkehren. Für eine laufende Buchung
gilt weiterhin der bei der Ausgabe erfasste Tagessatz. Die Freigaben für
Verantwortliche und für Kosten bleiben getrennt.
Die Prüfung der Zuordnungen über Fachstände hinweg ist noch offen, wenn die
Sicherung das zugehörige Werkzeug oder Projekt noch nicht enthält.

Auch endgültige Dokumentsperren, unveränderliche Datensätze und
Abwesenheitsentscheidungen erhalten unabhängige Nachweise. Sobald ein
OpenTimestamps-Nachweis gespeichert wurde, wird auch dieser aufbewahrt. Ein
Ausfall der Zeitstempelserver verhindert weiterhin keine Bearbeitung und keine
Entscheidung. Die Sperre hängt nicht davon ab, ob bereits ein externer
Zeitstempel vorliegt. Das Rückspielen einer älteren Mandantendatei darf diese
späteren Festschreibungen nicht verschwinden lassen.

Enthält eine Sicherung den Entwurf einer später abgeschlossenen
Auftragsbestätigung, bleibt die abgeschlossene Fassung abrufbar. Die API liest
ihre verschlüsselten Teile und die signierte Versionskette aus dem Fachstand,
in dem sie festgeschrieben wurde. Fehlt in der Sicherung schon die erste
Dokumentversion, verweigert die API die Freigabe. Der ältere Vorgang könnte
sonst ohne den verschlüsselten Eintrag für das abgeschlossene Dokument erscheinen.

Die API kann einen vorbereiteten älteren Fachstand unter Beibehaltung der
aktuellen Recovery- und Berechtigungsnachweise freigeben. Dafür sind eine
aktive Administratorsitzung des Mandanten und eine Signatur der
Mandantenautorität nötig. Die Signatur bindet die Freigabe an die konkrete
Sicherung und den bisherigen Fachstand. Der Datendienst weist
Mandantendateien mit veralteten Sicherheitsnachweisen weiterhin ab. Auch eine
gemeinsame Rücksetzung von Mandanten- und Kontrolldatei auf einen alten Stand
braucht unabhängige aktuelle Nachweise, um erkennbar zu bleiben.

Der API-Speicherzugriff unterstützt dafür getrennte Ablagen je Fachstand.
Konten samt Freigaben und Schlüsseln behalten ihren aktuellen Stand. Die Zähler
für Rechnungen und Lieferscheine werden weitergeführt. Festgeschriebene Datensätze
behalten ihre bisherige Ablage; Listen und
Einzelabrufe berücksichtigen sie auch dann, wenn der ausgewählte ältere Stand
sie noch nicht enthält. Die API prüft die Signatur der Mandantenautorität für
den ausgewählten Fachstand. Begonnene Lese- und Schreibvorgänge müssen beim
Abschluss weiterhin zu diesem Stand passen. Ein Fachstandswechsel erhöht den
Lesestand aller Bereiche, auch wenn sich deren Schlüssel und Berechtigungen
nicht ändern. Alte Einträge im Browser können dadurch nicht als aktuell
bestätigt werden.

Unter **Verwaltung → Organisation → Sicherungen** stehen die fertigen
Sicherungen des eigenen Mandanten zur Auswahl. **Sicherung prüfen** bereitet
eine Kopie vor, während Mitarbeiter mit dem aktiven Stand weiterarbeiten. Der
Datendienst prüft beim Kopieren die Inhaltsadressen der Chiffrate. Ein
unterbrochener Auftrag lässt sich mit derselben Kennung über jede
API-Instanz fortsetzen.

Der Browser prüft die Signaturen und das Datenmodell der lesbaren Projekte
und Adressdaten. Er zeigt deren Anzahl sowie fehlende Verknüpfungen zu Kunden
oder Kontakten an, soweit deren Kataloge lesbar sind. Andere verschlüsselte
Fachdaten und ihre Verknüpfungen sind in dieser Vorschau noch nicht abgedeckt.
Erst **Fachdaten wiederherstellen** gibt den vorbereiteten Stand frei. Die
Freigabe erfordert die Administratorrolle und den Schlüssel der
Mandantenautorität im Browser.

Bei der Freigabe prüft die API die öffentlich prüfbaren Verweise von
abgeschlossenen Dokumenten, persönlichen Einsatzzuweisungen und
Werkzeugbuchungen mit einem Verantwortlichen. Bestehende Schlüssel und
Freigaben gelten weiter. Die Mandantenautorität signiert dieselben Regeln mit
einer neuen Schreibversion. Dadurch kann die API ältere, ausstehende Pakete
abweisen. Die aktivierte Auswahl, der Freigabebeleg und die Schreibversion
werden gemeinsam gespeichert. Verbundene Editoren erkennen den Wechsel und
öffnen den neuen Stand.

Bei delegierten Regeln bindet die Mandantenautorität den Übergang an die
bisherige Richtliniensignatur und den neuen Fachstand. Die ursprünglichen
Signaturen der Profile bleiben erhalten. Berechtigte Verwalter können danach
wie gewohnt einzelne Profile ändern.

## Erstellung und Nachweise

Der gemeinsame Datendienst erstellt die Kopie mit `COPY FROM DATABASE`, schließt
sie, synchronisiert die Datei und veröffentlicht sie durch atomare Umbenennung.
Unvollständige Dateien sind nicht herunterladbar. Wiederholungen verwenden eine
Kennung, die Mandant und Auftrag bindet. Die API speichert den offenen Auftrag
vor dem Kopieren und bestätigt die fertige Datei durch einen Versionsvergleich.
Ein verlorener Abschluss kann dadurch wiederaufgenommen werden.

Die API streamt den Download; sie wandelt die Datei nicht in Base64 oder ein
RPC-Ergebnis um. Das Dienstkennwort bleibt intern. Der Browser fordert die Datei
mit dem Betreiberzugang an und bietet sie als Download an; dabei hält er sie
vorübergehend als Blob im Speicher. Für sehr große Sicherungen ist ein direkter
Dateischreibweg noch offen.

Der [Datendiensttest](../sortsys-store/tests/service.rs) prüft konkurrierende
Aufträge und eine Wiederholung nach weiteren Änderungen. Der
[native API-Test](../sortsys-webapp-v2/scripts/test-operator-telemetry.ts) prüft
zusätzlich zwei API-Instanzen, verweigerte Zugriffe und die Mandantenbindung.
Die
[Browser-E2E-Suite](../sortsys-webapp-v2/scripts/e2e/development.browser.mjs)
legt eine Sicherung des Musterbestands an, lädt sie herunter und prüft ihre
Sichtbarkeit nach einem Neuladen.

Der [Rücksicherungstest](../sortsys-webapp-v2/scripts/e2e/contentRestore.browser.mjs)
nutzt die gebaute Webapp und zwei getrennte API-Prozesse an derselben DuckDB.
Er prüft, dass ein Abbruch den aktuellen Projektstand erhält und die
Bestätigung danach den älteren Stand sichtbar macht. Der zugehörige
[API-Test](../sortsys-webapp-v2/scripts/test-native-content-preparation.ts)
prüft auch die Trennung der Sicherungslisten verschiedener Mandanten.
