# Personaldaten und getrennte Kostenfreigaben

Die Personalliste, die Suche und die Bearbeitung vorhandener Profile lesen und
speichern im Browser. Die Werkzeugverwaltung verwendet diese Profile für die
Personenauswahl und Namensanzeigen. Namen und Suchbegriffe gehen dabei nicht an
die bisherigen `users`-Endpunkte der API.

Für jede Person gibt es drei getrennt verschlüsselte Bereiche:

| Bereich         | Inhalt                                                                      |
| --------------- | --------------------------------------------------------------------------- |
| Stammdaten      | Name, Anmeldename, Kontaktdaten, Vertragsart und übernommene Kontometadaten |
| Personalangaben | Vorgesetzter und jährlicher Urlaubsanspruch                                 |
| Kalkulation     | Interner Stundensatz                                                        |

Eine Lesefreigabe für Namen öffnet weder den Stundensatz noch die
Personalangaben. So kann die Werkzeugausgabe einen Verantwortlichen auswählen,
ohne dessen Kosten zu laden. Beim Speichern werden die gelesenen Profilversionen
als zusätzliche Bedingung mitgegeben; eine zwischenzeitliche Änderung führt zum
Konflikt.

Der Benutzerteil von `auth.sessionInfo` enthält nur Benutzerkennung, Anmeldename
und Sprache. Die aktuelle
[Sprachwahl](verschluesselte-ansichtseinstellungen.md#oberflächensprache) ist
eine technische Kontoeinstellung und gehört nicht zum verschlüsselten
Personalprofil. Namen, Kontaktdaten und Vertragsart liest die API nicht aus der
Benutzertabelle; auch die technische Protokollierung verwendet den Anmeldenamen.
Im aktiven Arbeitsbereich ergänzt der Browser freigegebene Profilangaben und den
Organisationsnamen aus den verschlüsselten Daten. Änderungen erscheinen über die
bestehenden Datenabonnements. Während der Bestandsübernahme bleibt dieser
Zugriff ausgeschaltet, damit die Anzeige kein Ersatzprofil vor der Übernahme
anlegt.

Ohne lesbares Profil zeigt die Oberfläche den Anmeldenamen. Fehlende Angaben
werden nicht als leere Personalakte oder als Einstufung „intern“ ausgegeben.
Eine ausstehende Profilabfrage blockiert die Arbeit nicht. Ein Rechte- oder
Kontowechsel entfernt die bisherigen Angaben sofort aus der Anzeige; verspätete
Antworten können sie nicht zurückbringen.

Das Bearbeitungsformular blendet nicht lesbare Kosten und Personalangaben aus.
Felder mit reiner Lesefreigabe sind schreibgeschützt. Es sendet ausschließlich
die Felder, für die eine Schreibfreigabe besteht. Eine Namensänderung
überschreibt deshalb keinen verborgenen Stundensatz. Der Datenkern kann
umgekehrt einen Stundensatz ändern, ohne den Namensbereich zu entschlüsseln. Für
diesen Zugang fehlt noch eine eigene Bedienoberfläche, die ohne Namensliste
auskommt.

Unter **Verwaltung → Organisation → Datenschutz** lässt sich zunächst das
Benutzerkonto auswählen, dessen Zugriffe geändert werden sollen. Im Abschnitt
**Personalzugriff** wird anschließend die betreffende Person ausgewählt. Für
Namen und Kontaktdaten, Personalangaben und den internen Stundensatz gibt es
jeweils eine eigene Rechteauswahl. Neben den festen Profilen bietet
**Individuell** getrennte Häkchen für Lesen, Anlegen, Bearbeiten und Löschen. So
lässt sich etwa die Personalliste für die Werkzeugausgabe öffnen, während die
Stundensätze nur für die Kalkulation verfügbar sind.

Das Speichern veröffentlicht die bearbeiteten Bereiche gemeinsam. Ein einzelnes
Häkchen ändert nur die betreffende Aktion; ein festes Profil setzt den gesamten
Aktionsumfang des Bereichs neu. Andere Bereiche behalten ihre aktuellen Regeln.
Auch die automatische Namensfreigabe bei der Benutzeranlage oder Reaktivierung
ersetzt keine bereits vorhandene Regel. Ein Fehler lässt die noch offenen
Änderungen im Formular stehen. Eine bereits bestätigte identische Freigabe wird
bei der Wiederholung nicht nochmals veröffentlicht; ein ausstehender
Schlüsselwechsel wird fortgesetzt.

Die Bestandsumstellung übernimmt die ursprünglichen Werte aus dem geprüften
Archiv, einschließlich der Stundensätze und Vorgesetztenzuordnungen. Wiederholte
Übernahmen akzeptieren identische Zielinhalte und überschreiben keine
abweichenden Profile. Ein durch die Mandanten-Recovery neu entstandenes
Administratorkonto erhält ein eigenes verschlüsseltes Profil. Bis zur
Bearbeitung steht dort der Anmeldename als Vorname; private Altwerte anderer
Personen werden nicht übernommen.

Der gemeinsame Datenkern prüft Feldtypen und die Zuordnung zum richtigen
Schlüsselbereich. Änderungen an Vorgesetzten oder der Vertragsart verbinden die
neuen Personalfragmente mit den daraus berechneten Abwesenheitsfreigaben. Alle
gelesenen Personalzuordnungen werden durch Versionsprüfungen abgesichert.
Selbstzuordnungen und Kreise werden abgewiesen; Vorgesetztenketten sind auf 120
Ebenen begrenzt. Dafür müssen die Personalzuordnungen lesbar und die
Mandantenautorität lokal verfügbar sein. Kontaktangaben oder der Urlaubsanspruch
bleiben unabhängig bearbeitbar. Einzelheiten beschreibt der
[Abwesenheitsablauf](abwesenheiten-protokoll.md).

## Benutzerzugänge

Die Verwaltung von Benutzerzugängen bleibt eine eigene Aufgabe. Das geschützte
Anlegen ist mit der [Einladungsverwaltung](benutzerfreigaben.md) verbunden. Der
Browser bestätigt die technische Anlage durch erneutes Lesen ihres signierten
Nachweises und veröffentlicht das Profil anschließend atomar. Eine genaue
Wiederholung mit derselben Anlagekennung ist zulässig; abweichende vorhandene
Profile werden nicht überschrieben. Nach einem Abbruch vor der
Profilveröffentlichung kann ein technischer Zugang ohne fertiges Profil
verbleiben. Das noch offene Formular kann die Anlage mit derselben Kennung
erneut versuchen.

Aktivieren, Deaktivieren, Archivieren und Entarchivieren veröffentlichen das
verschlüsselte Profil zusammen mit dem technischen Kontostatus. Beim Aktivieren
und Deaktivieren gehört auch die signierte Zugriffssperre zu dieser Transaktion.
Ein Konflikt bei einem dieser Teile verwirft die gesamte Änderung, auch wenn
zwei API-Instanzen beteiligt sind. Eine verlorene Antwort wird durch das erneute
Lesen der verschlüsselten Fassung und des signierten Änderungsnachweises
geprüft.

Die Deaktivierung beendet vorhandene Sitzungen und sperrt sämtliche Bereiche des
Kontos. Die einzelnen Freigaben bleiben erhalten, damit die Reaktivierung sie
wiederherstellen kann. Betroffene Bereiche erhalten neue Schlüssel. Jeder
Browser prüft vor weiteren Schreibvorgängen die Schlüsselempfänger gegen die
signierte Rechteregel; ein bloß zurückgesetztes Datenbankflag reicht dafür nicht
aus. Bereits gelesene Daten und bekannte alte Schlüssel lassen sich durch eine
Sperre nicht zurückholen. Die Reaktivierung gibt der Administration keine
Schlüssel für den persönlichen Assistentenverlauf anderer Konten.

Archivieren setzt ein deaktiviertes Konto voraus. Entarchivieren lässt die
Deaktivierung bestehen; Aktivieren hebt auch die Archivierung auf. Diese
Aktionen benötigen die Verwaltungsbefugnis und Schreibzugriff auf die Stammdaten
der betroffenen Person. Änderungen am eigenen Kontostatus sind ausgeschlossen.

Die Administration kann Anmeldenamen im Personalformular ändern, auch den
eigenen. Dafür sind Verwaltungsbefugnis, der lokale Mandantenautoritätsschlüssel
und Schreibzugriff auf die Stammdaten nötig. Anmeldemetadaten, Namensindex und
verschlüsseltes Profil werden gemeinsam veröffentlicht. Ein belegter Name oder
eine konkurrierende Änderung verwirft den gesamten Vorgang, einschließlich
gleichzeitig geänderter Kontaktdaten, Stundensätze oder Vorgesetztenzuordnungen.
Bei verlorener Antwort bestätigt der Browser den signierten Änderungsnachweis
und sämtliche verschlüsselten Fassungen erneut.

Die unveränderliche Kontokennung bindet Passwortanmeldung, Tresor und
Passkey-Schlüsselpakete. Ein anderer Anmeldename ändert deshalb weder Passwort
noch Schlüssel oder vorhandene Sitzungen. Die nächste Anmeldung verwendet den
neuen Namen. Bereits ausgestellte Einladungen sind an ihren bisherigen
Anmeldenamen gebunden; für noch nicht registrierte Konten ist nach einer
Umbenennung eine neue Einladung erforderlich.

Das Löschen von Konten und Rollenänderungen sind noch offen. Abwesenheiten,
Urlaub und Standardvorgesetzte verwenden ihren eigenen
[verschlüsselten Fachadapter](abwesenheiten-protokoll.md).

Die lokale Suche berücksichtigt Namen, Anmeldenamen, E-Mail, Telefon und
Vertragsart. Sie verwendet Wortpräfixe aus dem gemeinsamen Suchweg; ein
vollständiger Vergleich mit der bisherigen PostgreSQL-Textsuche steht aus. Nicht
freigegebene Profile sind kein Bestandteil der Suchergebnisse.

Die API prüft signierte Schreibrechte und Versionen. Sie kann geheime Inhalte
nicht fachlich prüfen; ein berechtigter veränderter Client kann deshalb
weiterhin falsche Angaben signieren. Diese Grenze beschreibt die
[Datenprüfung](verschluesselung-datenpruefung.md).

Der [native Fachadapterlauf](development.md#native-tests-ohne-entwicklungsstack)
verwendet getrennte API-Prozesse und einen gemeinsamen DuckDB-Dienst. Der Test
für Umbenennungen prüft belegte Namen, manipulierte Befehle und konkurrierende
Änderungen. Nach einer verlorenen Antwort müssen Anmeldename, Stundensatz und
Vorgesetztenzuordnung gemeinsam lesbar sein. Bestehende Sitzungen und
Kontotresore bleiben erhalten. Browsertests prüfen zusätzlich, wer das Feld im
Personalformular bearbeiten kann. Der vollständige Vergleich der Textsuche
bleibt offen.
