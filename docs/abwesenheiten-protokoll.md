# Technischer Schutz von Abwesenheitsanträgen und Entscheidungen

Für einen Urlaubsantrag werden Zeitraum und Begründung benötigt. Eine spätere
Entscheidung darf diese Angaben nicht unbemerkt ersetzen. Der neue Speicherpfad
trennt deshalb den Antrag von seiner Genehmigung oder Ablehnung. Bibliothek,
Browser-Datenkern, Fachadapter, Bestandsübernahme und Formulare verwenden diesen
Pfad. Die Vorgesetztenzuordnung verteilt Entscheidungsrechte als signierte
Regeln.

## Zwei Bereiche je Person

Die signierten technischen Namen legen fest, welche Aktion gespeichert wird. Ein
Feld wie `status: "approved"` vergibt keine Genehmigungsberechtigung.

| Datensatz    | Objektkennung                                  | Schlüsselbereich               | Erforderliche Schreibaktion |
| ------------ | ---------------------------------------------- | ------------------------------ | --------------------------- |
| Antrag       | `absence:<userId>:request:<id>`                | `absence:<userId>:master-data` | `create`                    |
| Entscheidung | `absence:<userId>:decision:<id>`               | `absence:<userId>:personnel`   | `approve`                   |
| Rücknahme    | Löschmarkierung unter derselben Antragskennung | Antragsbereich                 | `delete`                    |

Beide normalen Datensätze haben ausschließlich Revision 1. Für einen Antrag ist
zusätzlich die leere, signierte Revision 2 als Löschmarkierung zulässig. Eine
Entscheidung lässt sich weder ändern noch löschen. Identische bestätigte Pakete
bleiben nach einer verlorenen Antwort wiederholbar.

Der Objektname ist an Person, Bereich und Datensatzart gebunden. Ein
gewöhnlicher Schreibberechtigter kann eine Entscheidung deshalb nicht unter
einem anderen Namen oder im Antragsbereich ablegen. Client und API prüfen
dieselbe Zuordnung. Anlegen und Bearbeiten im Entscheidungsbereich ersetzen
`approve` nicht. Der allgemeine Datenkern kann nun auch diese Aktion prüfen,
ohne dafür gewöhnliche Schreibrechte zu vergeben.

## Gleichzeitige Genehmigung und Rücknahme

Jeder Schreibvorgang nennt die geprüften Ausgangsstände beider Bereiche. Die API
sperrt beide in der gemeinsamen Reihenfolge ihrer Bereichssperren. Anschließend
prüft sie im selben Datenbankvorgang den vollständigen neuen Zustand:

- Eine neue Entscheidung braucht den vorhandenen Antrag in Revision 1. Ein
  zurückgenommener Antrag kann nicht mehr entschieden werden.
- Eine Rücknahme ohne Entscheidung benötigt Löschen im Antragsbereich. Sobald
  eine Entscheidung vorliegt, ist zusätzlich Löschen im Entscheidungsbereich
  erforderlich. Das Entscheidungsrecht allein schließt dieses Löschrecht nicht
  ein.
- Gleichzeitiges Entscheiden und Zurücknehmen in einem Paket wird verworfen. Die
  Prüfung bleibt unabhängig von der Reihenfolge der Pakete.

Diese Regeln verwenden Objektkennungen, Revisionen und öffentliche Rechte. Die
API entschlüsselt weder Zeiträume noch Begründungen oder Entscheidungen. Der
gemeinsame DuckDB-Datendienst bestätigt die gelesenen Ausgangsstände und die
Änderungen in einer Transaktion, unabhängig von der beteiligten API-Instanz.
Personenkennungen, Schlüsselbereiche und signierte Freigaben bleiben für die API
sichtbar. Aus automatischen Freigaben können Vorgesetztenbeziehungen erkennbar
werden; auch diese Metadaten sind nicht durch Inhaltsverschlüsselung verborgen.

Die zusätzliche Löschfreigabe für entschiedene Anträge wird dabei gegen den
Transaktionsstand geprüft. Der bisherige Empfängerpfad bestätigt bei einer
Löschmarkierung das Antragslöschrecht des Autors. Er liefert noch keinen
kryptografischen Nachweis, dass damals keine Entscheidung vorhanden war oder die
zusätzliche Löschfreigabe galt. Das ist eine verbleibende Grenze gegenüber einem
Betreiber, der gültig signierte Datensätze ausblendet; das Entscheidungsobjekt
kann dadurch nicht mit gewöhnlichen Schreibrechten gefälscht werden.

## Prüfung im Browser

Der Browser prüft jeden Autor gegen die signierte Regelversion des gespeicherten
Objekts. Neben der passenden Schreibaktion muss der Autor damals das
erforderliche Leserecht gehabt haben. Für Abwesenheiten gilt diese Voraussetzung
für beide Bereiche. Die Ausnahme für vorbereitete Dokumentblöcke darf eine
Genehmigung nicht als gewöhnliche Änderung durchlassen.

Die Bibliothek stellt dafür `absenceRecord` und `objectWriteAction` bereit.
Paketbauer, historische Autorenprüfung und Datenkern verwenden denselben Pfad.
Eine neue Lesefreigabe kann über den bestehenden Schlüsselwechsel auch die
benötigten früheren Bereichsschlüssel erhalten.

Der Fachadapter bindet die entschlüsselte Entscheidung an die exakte Signatur
des zugehörigen Antrags. Eine andere gültig signierte erste Revision übernimmt
diese Entscheidung dadurch nicht. Der Antragsinhalt darf selbst ausschließlich
den Status `requested` enthalten; der sichtbare Genehmigungsstatus entsteht aus
der separat geprüften Entscheidung. Bei neuen Datensätzen müssen die genannten
Antragsteller beziehungsweise Entscheider mit dem tatsächlichen Unterzeichner
übereinstimmen.

Ein Antrag und seine sofortige Genehmigung werden gemeinsam gespeichert, wenn
der Ersteller ausdrücklich Entscheidungsrecht besitzt. Dafür wird die fertige
Antragssignatur in das zweite vorbereitete Paket übernommen. Gleiche gelesene
Bereichsversionen werden bei der Veröffentlichung zusammengefasst; verschiedene
Versionen desselben Bereichs führen bereits im Browser zum Konflikt.

## Formulare, Kontingente und Bestandsübernahme

Die Abwesenheitsliste und die Einsatzplanung lesen dieselben entschlüsselten
Datensätze. Änderungen und neue Personalangaben aktualisieren offene Listen über
die gemeinsame Datenlaufzeit. Formulare übertragen Kalendertage als Datumstext;
eine Sommerzeitumstellung verschiebt dadurch keinen Antragstag. Ein erneuter
Speicherversuch behält seine Vorgangskennung. Genehmigung, Ablehnung und Löschen
nennen den angezeigten Versionsstand.

Urlaubskontingente werden je Kalenderjahr berechnet. Gezählt werden Montag bis
Freitag; überlappende genehmigte Zeiträume zählen nur einmal. Feiertage werden
wie im bisherigen API-Pfad nicht abgezogen. Ohne Freigabe der Personalangaben
bleibt der Jahresanspruch unbekannt und erscheint nicht als null Tage.

Bei der Bestandsübernahme bleiben frühere Antragsteller, Entscheider, Zeitpunkte
und Ablehnungsgründe erhalten, einschließlich zulässiger fehlender Angaben in
Altdaten. Eine zusätzliche Signatur der Mandantenautorität bestätigt diese
Ausnahme von der normalen Bindung an den Unterzeichner. Eine bloße
Altdatenkennzeichnung reicht nicht. Die Wiederaufnahme prüft vorhandene Inhalte
und ihre Nachweise; abweichende oder zusätzliche Zielobjekte werden nicht
ersetzt. Nach einem Autoritätswechsel können gültige frühere Nachweise
weiterverwendet werden. Ein gespeicherter Standardvorgesetzter wird ebenfalls
aus der bestätigten Sicherung übernommen. Dabei bleiben auch große
Personenkennungen exakt. Ein Verweis auf eine im Backup nicht vorhandene Person
gilt als unbesetzt; sein ursprünglicher Wert bleibt im unveränderten Quellarchiv
erhalten.

Die Personalfreigaben unterscheiden Anträge von Entscheidungen und bieten ein
eigenes Entscheidungsrecht. Beide Lesefreigaben sind Voraussetzung für den
Fachzugriff. Einladungen erhalten zunächst eigene Anträge mit Anlege- und
Rücknahmerecht sowie Lesezugriff auf die eigenen Entscheidungen. Nach der
Zertifizierung erhalten interne Personen ohne zuständigen Vorgesetzten sowie
externe Kräfte und Nachunternehmer außerdem das eigene Entscheidungsrecht. Ihre
Anträge werden dadurch sofort genehmigt. Vorgesetzte dürfen die Anträge aller
nachgeordneten Personen lesen und entscheiden, auch über mehrere Ebenen. Dafür
werden ebenfalls die Personalangaben mit Urlaubsanspruch und
Vorgesetztenzuordnung freigegeben; interne Stundensätze bleiben getrennt.

## Automatische Freigaben nachführen

Unter **Verwaltung → Organisation → Personal** lässt sich ein
Standardvorgesetzter festlegen. Er übernimmt die Freigabe für interne
Mitarbeiter ohne direkte Zuordnung. Eine vorhandene Zuordnung und deren
übergeordnete Vorgesetzte bleiben maßgeblich; der Standard wird nicht zusätzlich
an jede Hierarchie angehängt. Der Standardvorgesetzte selbst erhält dadurch
keine Selbstzuordnung. Externe Kräfte und Nachunternehmer behalten ihr eigenes
Entscheidungsrecht.

Die Einstellung ist ein eigenes verschlüsseltes Organisationsobjekt. Die
Oberfläche verlangt die nötigen Schreibrechte und die lokal geöffnete
Mandantenautorität. Auswahl und Entfernen veröffentlichen das Objekt und die
daraus berechneten Freigaberegeln gemeinsam. Auch spätere Änderungen an
Personalprofilen lesen die Einstellung als geprüfte Voraussetzung. Gleichzeitige
Änderungen können deshalb nicht einen neuen Personalstand mit veralteten
Standardrechten verbinden. Ein vorhandenes, aber beschädigtes oder unlesbares
Objekt gilt nicht als leer. Bei einer neuen Organisation bedeutet das
nachgewiesene Fehlen der optionalen Einstellung, dass kein Standard festgelegt
ist.

Automatische Regeln tragen die signierte Herkunft `absence-default`. Eine
Neuberechnung ersetzt nur diese Regeln. Manuelle Freigaben bleiben bestehen;
ausdrückliche Verbote gelten auch gegenüber neuen automatischen Freigaben. Die
Zuordnung darf nicht aus einer als `null` dargestellten, tatsächlich aber
unlesbaren Personalangabe abgeleitet werden. Der Browser benötigt die
vollständigen Personalzuordnungen und verweigert widersprüchliche oder zyklische
Ketten.

Ändert die Administration einen Vorgesetzten oder die Vertragsart, werden die
betroffenen Personalfragmente und die neu berechneten Regeln gemeinsam
gespeichert. Das signierte Transaktionsmanifest nennt die vorherige
Regelsignatur, die exakten Signaturen der verschlüsselten Änderungen und alle
gelesenen Bereichsstände. Die API sperrt diese Stände und veröffentlicht Daten
und Regeln in derselben Transaktion. Ein Manifest lässt sich weder mit anderen
Personalpaketen kombinieren noch über den gewöhnlichen Aufruf zum Ersetzen der
Rechte allein anwenden.

Auch eine reine Erstberechnung aus vorhandenen Profilen sichert ihre gelesenen
Ausgangsstände ab. Beim Wechsel eines Vorgesetztenzweigs werden die Freigaben
für dessen nachgeordnete Personen neu berechnet. Entzogene Leserechte lösen den
bestehenden Schlüsselwechsel aus. Unterbrochene Schlüsselwechsel können in der
Organisationsverwaltung fortgesetzt werden; neue Leser erhalten dort auch die
berechtigten historischen Schlüssel.

Gewöhnliche Personalbearbeiter können weiterhin Kontaktdaten oder den
Urlaubsanspruch ändern. Vorgesetztenzuordnung und Vertragswechsel benötigen im
normalen Anwendungspfad die lokal verfügbare Mandantenautorität. Ein vom
Betreiber vergebenes Administratorflag genügt dafür nicht.

Die Zugriffsregeln bleiben eine eigene signierte Quelle. Ein manipulierter
Client mit Schreibrecht auf ein Personalfragment kann dort weiterhin eine
widersprüchliche Vorgesetztenangabe behaupten. Die API kann diesen geheimen
Feldinhalt nicht mit den Regeln vergleichen. Die Behauptung erteilt aber keine
neuen Leseschlüssel oder Entscheidungsrechte. Die normale Oberfläche prüft die
Zuordnung und veröffentlicht sie zusammen mit der passenden Rechteänderung.
Diese Grenze gehört zur
[Datenkonsistenz ohne Klartextprüfung](verschluesselung-datenpruefung.md).

## Prüfstand und weiterer Anschluss

Die Tests verwenden echte verschlüsselte und signierte Pakete. Sie prüfen
falsche Bereiche, fremde Personenkennungen, gewöhnliche Schreibrechte ohne
Entscheidungsrecht, nachträgliche Änderungen und fehlende historische
Leserechte. Öffentliche Browser-Testvektoren werden zusätzlich von Rust geprüft.
Die Referenztests unterscheiden fehlende, vorhandene und zurückgenommene Anträge
sowie die Berechtigung, bereits entschiedene Abwesenheiten zu entfernen.

Der [native Mehrinstanztest](development.md#native-tests-ohne-entwicklungsstack)
verwendet zwei unabhängige API-Zustände mit eigenen HTTP-Servern und dem
gemeinsamen DuckDB-Datendienst über Quack. Konkurrierende Entscheidungen ergeben
genau einen angenommenen Stand. Gewöhnliche Änderungen bleiben trotz voller
Schreibrechte gesperrt. Eine zulässige Rücknahme bewahrt den ursprünglichen
Antrag und seinen Zeitnachweis. Dieser Test verwendet synthetische
verschlüsselte Protokollpakete.

Der zusätzliche Fachadapterlauf prüft mit dem tatsächlichen Webapp-Code die
Bestandsübernahme angefragter, genehmigter und abgelehnter Abwesenheiten,
wiederholbare Anlagen, verlorene und falsche Antworten sowie konkurrierende
Entscheidungen und bedingte Rücknahmen. Er verwendet zwei getrennte
API-Prozesse. Abwesenheitsdaten und Originalbelege bleiben nach zwei Recoveries
lesbar.

Die Fachtests prüfen getrennt davon die Bindung an Antragssignatur und
Unterzeichner, die Kontingentberechnung und die wiederholbare Bestandsübernahme.
Für die automatischen Freigaben prüfen sie zusätzlich ganze Vorgesetztenzweige,
manuelle Ausnahmen, verlorene Antworten und konkurrierende Quelländerungen. Die
automatischen Freigaben entlang ganzer Vorgesetztenzweige sind damit noch nicht
vollständig im Mehrinstanzlauf geprüft; ein Administratorrecht auf dem Server
ersetzt weder Leseschlüssel noch eine signierte Freigabe.

Der Browserlauf ergänzt die Standardzuordnung: Ein normales Konto stellt
zunächst einen automatisch genehmigten Antrag. Nach dem Setzen des Standards
bleibt sein nächster Antrag offen. Die Administration genehmigt ihn über eine
andere API-Instanz; die bereits geöffnete Mitarbeiteransicht zeigt die
Entscheidung ohne Neuladen. Derselbe Ablauf prüft das erneute Laden der Auswahl
und das Entfernen des Standards. Ausgefallene OpenTimestamps-Kalender verhindern
diese Schritte nicht.

Abwesenheitsanträge, Entscheidungen und Rücknahmen werden außerdem getrennt für
einen [OpenTimestamps-Zeitnachweis](zeitnachweise.md) vorgemerkt. Ein fehlender
Beleg oder ein Kalenderausfall ändert die unveränderlichen Originale und ihre
Berechtigungsprüfung nicht.
