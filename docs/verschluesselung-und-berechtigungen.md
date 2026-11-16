# Verschlüsselte Mandantendaten und abgestufte Berechtigungen

Architekturentwurf vom 8. November 2026, fortgeschrieben während der Umsetzung
auf `draft/zerotrust`. Das [Framework](../sortsys-zerotrust/README.md) steht als
TypeScript-Paket und Rust-Crate bereit; die Fachbereiche werden daran
angeschlossen. Bestehende Produktivmandanten wurden nicht umgestellt. Der
Entwurf legt fest, wie ein Betrieb seine Daten gemeinsam bearbeiten kann, ohne
dass der normale API-Betrieb oder ein Datenbankzugriff die vertraulichen Inhalte
offenlegt.

Der ausgelieferte Client und seine Aktualisierungen gelten als vertrauenswürdig.
Bei aufgerufenen LLM-Funktionen dürfen die dafür freigegebenen Inhalte beim
Betreiber und Modellanbieter im Klartext verarbeitet werden. Ein Schutz gegen
absichtlich veränderten Anwendungscode ist nicht Gegenstand dieses Entwurfs. Der
[Funktionsabgleich](verschluesselung-funktionsabgleich.md) bewertet die Folgen
für bestehende Arbeitsabläufe; die
[Mandantenwiederherstellung](mandanten-wiederherstellung.md) beschreibt den
Notfallzugang mit einer nach Gebrauch wechselnden Seed-Phrase. Die
[Datenprüfung](verschluesselung-datenpruefung.md) unterscheidet technische
Servergarantien von fachlichen Clientprüfungen. Der erste Ausbau verwendet
keinen abgeschirmten Datendienst und keine Klartextprüfung durch die API.
Dadurch bleiben bestimmte fachliche Konsistenzgarantien ausdrücklich geringer
als im bisherigen Klartextmodell.

Für Beschäftigte bleibt der gewohnte Arbeitsablauf maßgeblich: anmelden,
Angebote bearbeiten, Aufmaße erfassen und gemeinsam an Dokumenten arbeiten.
Schlüsselerzeugung, Freigaben und notwendige Datenumstellungen erledigt die
Anwendung im Hintergrund. Ein zusätzliches Schlüsselpasswort, ein Schlüsselmenü
oder manuell auszulösende Verschlüsselungsschritte gehören nicht in diesen
Ablauf. Die Administration vergibt weiterhin fachliche Rollen und Zugriffe.

Für den Notfall sichert die Administration einmalig die Wiederherstellungsphrase
der Organisation. Diese Sicherung ist vom normalen Benutzerzugang getrennt;
Beschäftigte benötigen weder die Phrase noch Kenntnisse über die verwendeten
Schlüssel. Der Draft bildet den gewohnten Ablauf noch nicht vollständig ab.

## Welche Rechte welche Inhalte öffnen

Das bestehende Rollenmodell unterscheidet `view:*`, `manage:*` und `delete:*`.
`manage:*` schließt Lesen ein; Löschen ist ein eigenes Recht. `:admin` erlaubt
derzeit alle Aktionen. Angebote, Kalkulation, Aufmaße und andere kaufmännische
Vorgänge verwenden überwiegend `view:projects` beziehungsweise
`manage:projects`. Die Umsetzung steht in
[auth.rs](../sortsys-api-v2/rust-api/src/auth.rs),
[Vorgangsadapter](../sortsys-webapp-v2/app/lib/data/commercial.ts) und im
[Rollenmodell der Oberfläche](../sortsys-webapp-v2/app/lib/roleModel.ts).

Für verschlüsselte Inhalte braucht jede Erlaubnis zusätzlich einen
Geltungsbereich und einen Inhaltsbereich. Eine Freigabe beschreibt
beispielsweise:

```text
Subjekt:         Benutzer oder Benutzergruppe
Geltungsbereich: Projekt 238427
Inhaltsbereich:  Aufmaß
Aktionen:        Lesen, Anlegen, Bearbeiten
Delegation:      keine
```

Geltungsbereiche sind der Mandant, ein Benutzer, ein Angebotsvorgang, ein
Projekt oder ein ausdrücklich freigegebenes Dokument beziehungsweise
Arbeitspaket. Angebotsvorgänge haben schon vor der Projektanlage einen eigenen
Geltungsbereich. Ein Projektverweis verknüpft später die Inhalte; daraus
entsteht keine zusätzliche Leseberechtigung. Die Gliederung eines GAEB-Dokuments
ist ebenfalls keine Berechtigungshierarchie.

Für kaufmännische Vorgänge werden mindestens diese Inhaltsbereiche getrennt:

| Inhaltsbereich            | Beispiele                                                |
| ------------------------- | -------------------------------------------------------- |
| Leistungsumfang           | OZ, Gruppen, Kurztexte, Beschreibungen, Einheiten        |
| Vertragsmengen            | Angefragte und beauftragte Mengen                        |
| Aufmaß                    | Maßansätze, Berechnungen, gemessene Mengen               |
| Angebotspreise            | Verkaufspreise, Nachlässe, Angebots- und Auftragssummen  |
| Interne Kalkulation       | Einkaufsansätze, Lohnansätze, Zuschläge, Margen          |
| Weitervergabe und Einkauf | Nachunternehmerpreise, Lieferantenangebote, Bestellungen |
| Abrechnung                | Rechnungspositionen, Zahlungen, offene Beträge           |

Weitere Bereiche erhalten dieselbe Behandlung: etwa Produktstammdaten getrennt
von `productPriceRecords`, sichtbare Mitarbeiterstammdaten getrennt von
Personalkosten. Ein Schlüssel für Projektdaten öffnet keine Personalkosten.

Die folgende Belegung ist ein Beispiel für explizite Projektfreigaben. Sie
ersetzt keine bestehende Rollenvorlage automatisch; insbesondere darf die
Bauleitung weiterhin Angebotspreise oder Kosten sehen, wenn der Betrieb ihr
diese Rechte gibt.

| Benutzer im Projekt | Leistungsumfang       | Vertragsmengen        | Aufmaß        | Angebotspreise           | Interne Kalkulation |
| ------------------- | --------------------- | --------------------- | ------------- | ------------------------ | ------------------- |
| Kalkulation         | Bearbeiten            | Bearbeiten            | Lesen         | Bearbeiten               | Bearbeiten          |
| Bauleitung          | Lesen                 | Lesen                 | Bearbeiten    | Lesen                    | Kein Zugriff        |
| Aufmaßteam          | Lesen                 | Lesen                 | Bearbeiten    | Kein Zugriff             | Kein Zugriff        |
| Nachunternehmer     | Nur sein Arbeitspaket | Nur sein Arbeitspaket | Nach Freigabe | Nur sein eigenes Angebot | Kein Zugriff        |

Server und Client werten dieselben versionierten Regeln aus. Ohne passende
Erlaubnis wird ein Zugriff abgelehnt; eine passende ausdrückliche Sperre hat
Vorrang. Eine Regel gilt nur für ihren angegebenen Geltungs- und Inhaltsbereich.
Anlegen, Bearbeiten, Löschen, fachliches Freigeben und Weitergeben werden
getrennt geprüft. Weitergeben darf nur delegierte Rechte im erlaubten Umfang
vergeben; es erlaubt weder eine Rechteerhöhung noch die Aufhebung einer fremden
Sperre. Bei einer Umstellung werden bestehende Rechte explizit auf diese
Bereiche abgebildet und vom Mandanten geprüft.

Die Rechteverwaltung zeigt die wirksamen Rechte und ihre Herkunft an, etwa
„Aufmaß bearbeiten durch Gruppe Bauleitung, Projekt 238427“. Für die Bedienung
bleiben Rollenvorlagen und Projektteams erhalten. Kryptografische Schlüssel
müssen nicht von Hand verwaltet werden.

## Schlüssel folgen den tatsächlichen Leserechten

Jeder Benutzer erhält clientseitig erzeugte Schlüssel für Entschlüsselung und
die Bestätigung seiner Geräte. Jedes Gerät besitzt zusätzlich einen eigenen
Signaturschlüssel. Ein geschützter Datenblock erhält einen zufälligen
Datenschlüssel. Ein ebenfalls zufälliger Bereichsschlüssel verpackt diese
Datenschlüssel; berechtigte Benutzer erhalten den Bereichsschlüssel für ihren
jeweiligen öffentlichen Schlüssel verschlüsselt. Empfänger müssen dafür nicht
gleichzeitig angemeldet sein.

Ein kryptografischer Bereich gehört zu einem Geltungsbereich, einem
Inhaltsbereich und einer konkreten Menge berechtigter Leser. Bei abweichenden
Leserechten werden unabhängige Bereiche gebildet. Schreibrechte können sich
innerhalb derselben Lesermenge unterscheiden, da sie durch Signaturen und
Erlaubnisse geprüft werden.

```text
Persönliche Schlüssel der berechtigten Leser
  öffnen verschlüsselte Bereichsschlüssel
    öffnen verpackte Datenschlüssel
      öffnen Datenblöcke und Dokumentänderungen
```

Ein vom Projekt- oder Mandantenschlüssel ableitbarer Schlüssel für sämtliche
Unterbereiche würde diese Trennung aufheben. Deshalb gibt es keinen allgemeinen
Projektschlüssel, mit dem ein Aufmaßteam anschließend auch die Kalkulation
entschlüsseln könnte. Auch bei mehreren Gruppen darf kein alternativer
Schlüsselpfad eine wirksame Sperre umgehen.

Eine vom Mandanten verwaltete Signaturautorität bestätigt Identitäten und
Delegationen. Dieser Vertrauensanker dient zur Prüfung von Freigaben; er ist
kein allgemeiner Entschlüsselungsschlüssel. Bereits eingerichtete Geräte
übernehmen keinen neuen Vertrauensanker allein aus einer Serverantwort.
Gerätezulassungen und Schlüsselpakete sind an die bestätigte Identität und
Freigabe gebunden. Der Recovery-Vertrauensanker ist davon getrennt: Er kann
ausschließlich mit der aktuellen Seed-Phrase gewechselt werden. Weder der
Provider noch eine normale Mandantenautorität darf eine Ersatz-Recovery
einrichten.

Der Draft verwendet AES-256-GCM über Web Crypto für Datenblöcke, AES-KW für
deren Datenschlüssel, HPKE für Schlüsselpakete und Ed25519 für Signaturen. HPKE
nutzt X25519, HKDF-SHA-256 und AES-256-GCM. Jede unveränderliche Blockversion
erhält einen frischen Datenschlüssel; Nonces dürfen unter demselben Schlüssel
nie wiederverwendet werden. Mandant, Objekt, Inhaltsbereich, Version und
Schlüsselgeneration werden authentifiziert eingebunden.

Nachrichtenformate und Größenlimits stehen im
[gemeinsamen Framework](../sortsys-zerotrust/README.md). Dessen allgemeiner
TypeScript-Einstieg und Rust-Crate enthalten keine sortsys-Fachmodelle. Die
Anwendung ergänzt ihre Inhaltsbereiche und Fachregeln über
`@sortsys/zerotrust/sortsys` beziehungsweise ihre API-Adapter. Die Tests
vergleichen browserseitig erzeugte Nachrichten mit der API; eine unabhängige
kryptografische Prüfung ersetzen sie nicht. HPKE ist in
[RFC 9180](https://www.rfc-editor.org/rfc/rfc9180.html) beschrieben; die
[libsodium-Dokumentation](https://doc.libsodium.org/public-key_cryptography/public-key_signatures)
erklärt die Trennung von Signaturen und authentifizierter Verschlüsselung.

## Anmeldung, Geräte und Wiederherstellung

Heute erhält `auth.login` das Passwort im Klartext innerhalb der TLS-Verbindung.
Ein daraus abgeleiteter Verschlüsselungsschlüssel wäre damit auch für die API
berechenbar. Dieser Anmeldeweg darf bei einem Ein-Passwort-Modell für geschützte
Konten nicht bestehen bleiben.

Vorgesehen ist OPAQUE für die Passwortanmeldung. Der Client verwendet dessen nur
clientseitig verfügbaren Export-Schlüssel zur Absicherung eines zufälligen
Kontoschlüssels. Dieser schützt private Identitäts- und Wiederherstellungsdaten.
Die API erhält das Passwort und den Export-Schlüssel nicht. JWT-Sitzungen, MFA,
gemeinsame Versuchslimits und Sitzungswiderruf bleiben zusätzliche Prüfungen.
OPAQUE ersetzt keine ausreichende Passwortstärke: Ein kompromittierter
Authentifizierungsserver kann weiterhin Passwortangriffe ermöglichen. Maßgeblich
sind [RFC 9807](https://www.rfc-editor.org/rfc/rfc9807.html) und eine geprüfte,
zwischen Rust und Browser interoperable Implementierung.

Registrierung, Passwortänderung und Wiederherstellung dürfen ebenfalls keinen
Klartext-Passwortweg zur API verwenden. Bestehende Konten benötigen eine
ausdrückliche Einrichtung des neuen Verfahrens; ein alter Bcrypt-Hash lässt sich
nicht in eine OPAQUE-Registrierung umwandeln. Zur Einrichtung empfiehlt sich ein
neues Passwort, das bisher nicht an die API übermittelt wurde.

Ein neues Gerät öffnet nach OPAQUE-Anmeldung und den geltenden MFA-Prüfungen den
verschlüsselten Kontospeicher. Mit der dort bestätigten Benutzeridentität wird
sein eigener Signaturschlüssel zugelassen. Die API liefert die bereits für
diesen Benutzer verpackten Bereichsschlüssel; andere Benutzer müssen dazu nicht
online sein. Das neue Gerät erhält keine bisher fehlenden Inhaltsrechte. Eine
Passwortänderung verpackt den Kontoschlüssel neu und erfordert keine
Neuverschlüsselung aller Geschäftsdaten.

Passkeys mit PRF-Unterstützung öffnen denselben Kontospeicher unmittelbar im
Browser, auch auf einem neuen Gerät. Die API erhält dafür ein signiertes
Schlüsselpaket, aber weder das PRF-Geheimnis noch den Kontodatenschlüssel. Ohne
PRF kann ein Passkey weiterhin anmelden; zum Entschlüsseln wird dann ein bereits
geschützter Gerätespeicher oder das gewöhnliche Passwort benötigt. Die Challenge
wird innerhalb derselben Datenbanktransaktion wie die Anmeldung verbraucht. So
können zwei API-Instanzen dieselbe Antwort nicht erneut annehmen, auch wenn der
Authenticator keinen steigenden Signaturzähler liefert.

Der Mandant richtet bei der Einführung eine Seed-Phrase für die
Wiederherstellung ein und bewahrt sie außerhalb der Betreiber-Infrastruktur auf.
Ihr Besitzer kann die betriebliche Schlüsselverwaltung und damit den Mandanten
wiederherstellen. Sie gehört deshalb in die Verantwortung der
Unternehmensleitung. Der normale Kontoadministrator erhält sie nicht
automatisch. Erstellung, einmalige Nutzung, Wechsel aller betroffenen Schlüssel
und unterbrochene Wiederherstellungen sind im
[Recovery-Konzept](mandanten-wiederherstellung.md) festgelegt.

Benutzerverwaltung allein verleiht keine Datenrechte. Der Support kann eine
Anmeldung zurücksetzen, aber ohne vorhandenes Gerät oder eine vom Mandanten
ausgeführte Wiederherstellung keine Geschäftsdaten entschlüsseln. Bei Verlust
aller geeigneten Schlüssel sind die betroffenen Daten nicht wiederherstellbar.
Beim Verlust eines Geräts werden dessen Sitzungen und Gerätezulassung gesperrt.
Da es persönliche Entschlüsselungsschlüssel besessen haben kann, werden diese
und die betroffenen Bereichsschlüssel ersetzt, sobald ein Zugriff auf das
entsperrte Gerät nicht ausgeschlossen werden kann. Nur das Sperren der
Gerätesignatur schützt keine zukünftigen, weiter an den alten Benutzerschlüssel
verpackten Daten. Sind auch Identitäts- oder Wiederherstellungsschlüssel
kompromittiert, werden diese ebenfalls ersetzt.

## Freigeben und Rechte entziehen

Eine Freigabe läuft so ab:

1. Ein berechtigter Mandantenbenutzer wählt Empfänger, Bereich und Aktionen aus.
   Freigeben erfordert eine ausdrückliche Delegation und Zugang zu den nötigen
   Schlüsseln; Leserechte allein erlauben keine registrierte Freigabe.
2. Sein Client prüft die bestätigten Empfängeridentitäten, signiert die
   Berechtigungsänderung und verpackt die betroffenen Bereichsschlüssel für die
   bestätigten Empfängeridentitäten.
3. Die API prüft Signatur, Delegationsumfang, Sitzung und erwartete
   Regelversion. Freigabe und Schlüsselpakete werden in einer Transaktion
   veröffentlicht.
4. Die Empfänger prüfen die Signaturkette und öffnen ihre Schlüsselpakete lokal.

Eine reine Änderung gespeicherter Rollen liefert deshalb noch keinen
entschlüsselbaren Bereichsschlüssel. Die API kann eine fehlende Freigabe nicht
selbst erzeugen. Ist gerade kein geeigneter Client verfügbar, bleibt sie als
ausstehend sichtbar. Ein Kontoadministrator ohne Datenrechte kann eine solche
Freigabe anfordern, aber nicht eigenständig vervollständigen.

Ein Rechteentzug ist ebenfalls eine signierte Berechtigungsänderung. Eine
Transaktion sperrt die betroffenen Zugriffe und erhöht die Berechtigungsversion.
Offene Verbindungen werden benachrichtigt; Schreibversuche mit der alten Version
werden auch an anderen API-Instanzen abgelehnt. Es gibt keine Frist, in der ein
bereits ausgestelltes WebSocket-Ticket alte Rechte erhält.

Sobald ein berechtigter Client verfügbar ist, erzeugt er neue Bereichsschlüssel
und verteilt sie ausschließlich an die verbleibenden Empfänger. Neue Inhalte
werden erst nach dieser Umstellung unter der neuen Schlüsselgeneration
geschrieben. Bis dahin pausieren betroffene Schreibzugriffe. Jede später neu
geschriebene Blockversion verwendet einen neuen Datenschlüssel; nur den alten
Datenschlüssel anders zu verpacken würde einen ausgeschlossenen Leser mit einer
alten Kopie nicht zuverlässig von neuen Inhalten ausschließen.

Ein Entzug von Schreibrechten allein braucht keinen Schlüsselwechsel, sofern die
Leserechte bestehen bleiben. Alte Signaturen bleiben als Urhebernachweis gültig,
erteilen aber kein Recht, nach dem Entzug neue Änderungen einzureichen.

Bereits entschlüsselter Inhalt bleibt dem früher berechtigten Leser bekannt.
Auch alte, mit alten Schlüsseln entschlüsselbare Sicherungen lassen sich nicht
zurückrufen. Das Modell schützt neue Inhalte nach einem Schlüsselwechsel.
Empfänger können gelesene Inhalte außerdem außerhalb der Anwendung weitergeben;
ein Freigabe- oder Exportverbot verhindert dieses Kopieren nicht kryptografisch.

## Ein Aufmaß bearbeiten, ohne die Kalkulation zu öffnen

Ein Mitarbeiter des Aufmaßteams öffnet den Auftrag. Sein Gerät erhält die
verschlüsselten Bereiche für Leistungsumfang, Vertragsmengen und Aufmaß. Für
Angebotspreise und interne Kalkulation fehlt ihm das Schlüsselmaterial. Diese
Inhalte sind daher auch über direkte API-Aufrufe nicht lesbar.

Der Client schreibt Maßansätze in einen eigenen Änderungsstrom. Jede Nachricht
bindet Mandant, Objekt, Inhaltsbereich, Regelversion, Schlüsselgeneration,
Geräteidentität, Nachrichten-ID und den verschlüsselten Inhalt in die Signatur
ein. Die API prüft äußeres Schema, Signatur, Referenzen und Schreibrechte.
Empfänger prüfen nach dem Entschlüsseln zusätzlich den tatsächlichen Inhalt.
Eine angenommene Nachricht gilt dadurch noch nicht als serverseitig fachlich
geprüft. Ein Maßansatz darf beispielsweise keinen Verkaufspreis verändern;
Empfänger müssen einen solchen Änderungsversuch vor der Übernahme ablehnen.

Ein gemeinsamer Yjs-Datenbestand für alle Felder wäre hierfür ungeeignet. Die
Streams werden an Lese- und Schreibgrenzen getrennt. Falls einzelne Positionen
oder Felder verschiedene Rechte haben, brauchen auch sie getrennte Streams oder
typisierte Änderungen mit entsprechend begrenztem Ziel. Ein undurchsichtiger
Yjs-Update-Block darf nicht als Nachweis für einen erlaubten Feldumfang gelten.

Ein Benutzer mit Leserechten kennt zwar einen symmetrischen Schlüssel und könnte
selbst gültige verschlüsselte Nachrichten erzeugen. Ohne zulässige
Gerätesignatur und passende aktuelle Schreibrechte werden diese jedoch weder
angenommen noch von anderen Clients angewendet. Signaturen müssen deshalb für
jede Änderung geprüft werden, bevor sie in einen CRDT-Zustand eingeht.

Historische Änderungen werden anhand der bei ihrer verbindlichen Aufnahme
geltenden Regeln und ihrer bestätigten Protokollposition geprüft. Ein späterer
Rechteentzug macht frühere zulässige Änderungen nicht ungültig. Noch nicht
übertragene Änderungen mit veraltetem Berechtigungsstand werden dagegen
abgelehnt, auch wenn ein Client sie zurückdatiert. Betroffene lokale Entwürfe
bleiben zur bewussten Wiederaufnahme durch einen aktuell Berechtigten erhalten.

Fachliche Übergänge werden separat autorisiert: beispielsweise Angebot abgeben,
Annahme erfassen oder Rechnung freigeben. Eine solche Signatur bezieht sich auf
den konkreten Dokumentstand. Nach einer Inhaltsänderung gilt die alte Freigabe
nicht für die neue Version. Wer eine vollständige Rechnung freigibt, muss deren
maßgebliche Inhalte auch lesen und prüfen können.

## Native GAEB-Dateien und abgeleitete Daten

Intern werden verschlüsselte Dokumentbestandteile mit einer signierten
Strukturbeschreibung gespeichert. Berechtigte Clients setzen daraus die native
X-Datei zusammen. Unbekannte XML-Elemente, Attribute, Formatierungen und Anlagen
bleiben erhalten. Unbekannte Inhalte werden zunächst dem restriktivsten
passenden Bereich zugeordnet; ohne sichere Zuordnung bleiben sie einem
vollständig berechtigten Bearbeiter vorbehalten.

Ein Client mit eingeschränkten Rechten bearbeitet seine erlaubten Bestandteile
und ersetzt niemals das gesamte Dokument durch seine unvollständige Ansicht. Ein
vollständiger nativer Download setzt Zugriff auf alle enthaltenen Bereiche
voraus. Für begrenzte Weitergaben wird ein eigenes Dokument erzeugt, dessen
Inhalt und Empfängerbereich ausdrücklich feststehen.

Eine Weitervergabe erhält deshalb ein eigenes Arbeitspaket mit den ausgewählten
Leistungen und den dort vereinbarten Preisen. Der Nachunternehmer erhält keinen
Schlüssel des ursprünglichen Gesamtangebots. Dasselbe gilt für eine Preisanfrage
an einen Lieferanten. Verweise auf die ursprünglichen Positionen erlauben später
die Zuordnung, ohne andere Positionen oder interne Preise freizugeben.

Die Trennung gilt auch für Listen, Summen, Suchindizes, Versionshistorien,
Vorschaubilder und Druckdateien. Aus Menge und Positionssumme lässt sich der EP
berechnen; eine verborgene Preiszelle bei lesbarer Summe schützt ihn nicht.
Auswertungen über vertrauliche Werte gehören mindestens in den Schutzbereich
dieser Werte. Eine bewusste Freigabe zusammengefasster Zahlen ist eine eigene
Fachentscheidung. Protokolle und Fehlermeldungen enthalten keine Inhaltskopien.

## Speicherung und mehrere API-Instanzen

Der gemeinsame DuckDB-Dienst speichert öffentliche Berechtigungsnachweise und
Versionen und führt deren Änderungen atomar aus; Dateispeicher enthalten
ausschließlich die jeweils verschlüsselten Nutzdaten. Technische Metadaten wie
IDs, Beziehungen, Bereichskennungen, Gerätezertifikate, Berechtigungen,
Generationen, Größen, Änderungszeiten und die UI-Sprache bleiben serverseitig
sichtbar. Fachliche Bezeichnungen, Adressen, Texte, Preise und Beträge werden
geschützt. Anmeldekennungen und für den Kontobetrieb benötigte Kontaktdaten
werden gesondert als notwendige Metadaten dokumentiert. Eine solche
Metadatensicht ist kein Versprechen, jegliche Rückschlüsse auf
Geschäftsaktivität auszuschließen.

Die API verwendet versionsgeprüfte Metadatensätze im gemeinsamen
DuckDB-Dienst. Die folgenden Namen bezeichnen Sammlungen dieser Datensätze,
keine zusätzlichen SQL-Tabellen:

| Sammlung | Inhalt |
| --- | --- |
| `accounts` | Technische Kontodaten, öffentliche Benutzerschlüssel, OPAQUE-Eintrag und verschlüsselter Kontospeicher |
| `crypto-root`, `authority-history`, `identity-history` | Aktueller Mandantenkopf, Zertifikate und gegengezeichnete Recovery-Übergänge für historische Absender |
| `policies`, `policy-generations` | Signierte Regeln und Zuordnung zur unterzeichnenden Autorität |
| `domain-catalog`, `domains`, `created-areas-*` | Bereichsverzeichnis, Schlüsselgenerationen, Leserzuordnung, signierte Anlegenachweise und paketgebundene Zuständigkeitsnachweise |
| `domain-definitions`, `key-envelopes` | Signierte Bereichsdefinitionen und verschlüsselte Schlüsselpakete je Empfänger und Generation |
| `objects-*`, `object-history`, `object-changes` | Referenzen auf signierte Chiffrate, Vorgängerversionen und eindeutige Nachrichten-IDs |
| `recovery-inventory-*`, `recovery-challenges`, `recovery-operations` | Verzeichnis früherer Schlüsselhüllen, zeitlich begrenzte Challenges und Nachweise abgeschlossener Wiederherstellungen |

Das Berechtigungsverzeichnis wird in Seiten mit höchstens 64 Bereichen gelesen.
Die erste Antwort enthält außerdem die Vertrauenskette und die signierte
Regelversion; Fortsetzungen wiederholen diese Nachweise nicht. Jede Seite wird
in einer eigenen Transaktion gegen Sitzung und aktuelle Rechte geprüft. Ein
Token bindet die Seiten an denselben Mandanten, dieselbe Sitzung, Regelversion
und Katalogversion. Es ersetzt keine Signaturprüfung im Browser.

Normale Inhaltsänderungen lassen diesen Abruf weiterlaufen. Bei einer
Werkzeugzuständigkeit gilt das auch für neue Buchungsrevisionen, solange deren
abgeleiteter Zugriff unverändert bleibt. Neue Bereiche,
Schlüsselwechsel oder geänderte Regeln verwerfen dagegen den begonnenen Abruf.
Dasselbe gilt, wenn eine Schlüsselvergabe den angezeigten Bedarf an einem
Schlüsselwechsel ändert. Der Browser beginnt dann vollständig von vorn und
wiederholt diesen Leseversuch höchstens zweimal. Er übernimmt keine Einträge aus dem
verworfenen Versuch. Ein gezielter Abruf von bis zu 16 Bereichen benötigt keine
Fortsetzung.

Für bereits vollständig geprüfte Verzeichnisse sendet der Browser beim nächsten
Aufruf deren Versionskennung mit. Die API prüft Sitzung und Rechte erneut und
bestätigt einen unveränderten Stand ohne die Verzeichniseinträge. Der Browser
verwendet dann seine geprüften öffentlichen Metadaten; signierte Regeln und
Vertrauenskette werden weiterhin geprüft. Ohne erfolgreiche Serverantwort gibt
es diesen Rückgriff nicht. Die Einträge bleiben im Arbeitsspeicher an Konto und
Verbindung gebunden und enthalten keine entschlüsselten Geschäftsdaten.

Für den Menüaufbau werden nur die Anlegenachweise gelesen. Bereiche ohne solche
Nachweise sind bereits durch die signierten Regeln abgedeckt und werden dafür
nicht zusätzlich aufgelistet. Dieser Abruf bindet seine Seiten an die Version der
Sammlung mit Anlegenachweisen statt an den gesamten Bereichskatalog. Neue
Anlegenachweise oder geänderte Regeln verwerfen ihn weiterhin; ein reiner
Schlüsselwechsel oder das Speichern eines Dokuments erfordert keinen erneuten
Menüabruf. Zuständigkeitsnachweise werden hingegen mit der jeweiligen
Buchungsrevision erneuert und ändern diese Sammlung auch bei gleichbleibenden
Leserechten.

Bei neuen Werkzeugbuchungen kann ein Anlegenachweis zusätzlich den zertifizierten
Verantwortlichen benennen. Ein gesonderter signierter Zugriffsstand bindet dessen
abgeleitetes Leserecht an die genaue Buchungsrevision. Die API speichert beide
in derselben Transaktion wie das Chiffrat; ein beendeter Stand lässt sich nicht
wieder aktivieren. Ohne aktuellen Nachweis entstehen keine solchen Leserechte.
Die API sieht dadurch die technische Zuständigkeit und deren Ende. Ob diese
Angabe zum verschlüsselten Fachinhalt passt, prüft der Browser.

`zerotrust.identities.get` liefert das öffentliche Zertifikat eines Kontos im
eigenen Mandanten. Für ein noch nicht registriertes, inaktives oder gesperrtes
Konto ist das Ergebnis `null`. Die Abfrage gibt weder Personalprofile noch
private Schlüssel frei. Eine neue Buchung kann deshalb auch ohne bestätigtes
Zielzertifikat bestehen; die automatische spätere Freigabe ist noch offen.

Neue Schlüsselbereiche werden in Stapeln mit höchstens 32 Definitionen
veröffentlicht und anschließend anhand ihrer signierten Nachweise zurückgelesen.
Auch Schlüsselhüllen, Integritätsnachweise und Benachrichtigungen gehören zur
jeweiligen Transaktion; diese zusätzlichen Datensätze begrenzen die Stapelgröße.

Für delegierte Rechteänderungen enthält der signierte Stand einen primären
Ausgangsstand und einzelne Empfängerprofile. Der Verwalter benötigt ein darin
erlaubtes `grant` für genau den betroffenen Bereich und Inhaltsbereich. Er
signiert mit seinem eigenen zertifizierten Identitätsschlüssel und kann nur
Aktionen vergeben, die er selbst besitzt. Verwaltungsrechte anderer Nutzer im
selben Bereich kann ausschließlich die primäre Mandantenautorität ändern.

Die API prüft zusätzlich zur Signatur den tatsächlichen Absender, dessen aktuelles
Zertifikat, den exakten Vorgänger und die erwartete nächste Version. Änderungen
auf einem früheren primären Stand dürfen keinen inzwischen neu signierten Stand
ersetzen. Ein neuer primärer Stand kann bestehende Mitarbeiterrechte beibehalten
und gleichzeitig die Verwaltungsbefugnis entziehen. Historische Signaturen
bleiben für frühere Dokumentstände prüfbar. Diese Unterscheidung zwischen
historischer Prüfung und aktueller Schreibfreigabe gilt auch für zwei Clients an
verschiedenen API-Instanzen.

Die gemeinsame Rechtefunktion unterstützt auch delegierte Lesefreigaben. Die
Hauptadministration stellt beim Vergeben von `grant` und `read` automatisch ein
öffentliches, bereichsgebundenes Schlüsselzertifikat aus. Der Verwalter signiert
damit historische Schlüsselkopien und neue Generationen mit seinem eigenen
Identitätsschlüssel. Ein entzogener Verwaltungszugriff sperrt neue
Veröffentlichungen; frühere Signaturen bleiben prüfbar. Die Verwaltungsoberfläche
muss für diese Konten noch geöffnet und auf deren einzelne Bereiche begrenzt
werden.

Bei geänderten Leserechten bündelt `zerotrust.access.publish` historische
Schlüsselkopien und neue Bereichsdefinitionen in einer Transaktion. Die API
prüft das aktuelle primäre oder bereichsgebundene Verwaltungsrecht, die erwartete
signierte Regelversion und die Leserechte aller Empfänger. Eine ungültige
Signatur oder ein inzwischen entzogenes Recht verwirft den gesamten Stapel. Die Regeländerung selbst wird
zuvor veröffentlicht; bis zum Abschluss eines nötigen Schlüsselwechsels bleibt
der Bereich für neue Inhalte gesperrt.

Der Client begrenzt einen Stapel auf 32 Schlüsselkopien beziehungsweise
Bereichsdefinitionen zusammen und acht MiB. Die Kopien eines Bereichs bleiben
mit dessen neuer Definition zusammen, solange sie in einen Stapel passen. Lange
Historien werden aufgeteilt; gespeicherte Wechselmarkierungen erlauben die
Fortsetzung. Nach jeder Veröffentlichung vergleicht der Client die vollständigen
signierten Definitionen und verschlüsselten Schlüsselpakete mit den gesendeten
Werten. Das gilt auch bei einer verlorenen Antwort. Die administrative Abfrage
`zerotrust.keys.inspect` erlaubt diese Prüfung für die tatsächlichen Empfänger;
sie erfordert deren aktuelles Leserecht und liefert keine entschlüsselten
Schlüssel. Die Prüfung einer delegierten Veröffentlichung verlangt zusätzlich
den tatsächlichen zertifizierten Verwalter als Absender sowie dessen aktuelles
Lese- und Verwaltungsrecht im jeweiligen Bereich.

Bei Einladungen und geänderten Freigaben bereitet der Browser unabhängige
Schlüsselgenerationen mit höchstens vier parallelen Abrufen je Bereich vor.
Dadurch können diese Abfragen die vorhandenen RPC-Pakete gemeinsam nutzen.
Eine Einladung bearbeitet höchstens vier Bereiche gleichzeitig und
veröffentlicht die vorbereiteten Schlüsselkopien ebenfalls über
`zerotrust.access.publish`. Eine Wiederholung prüft auch hier die tatsächlich
gespeicherten Pakete. Der Zugriff auf eine ungültige Schlüsselhistorie wird
abgebrochen, bevor deren vorbereitete Kopien veröffentlicht werden.

Der RPC-Transport bündelt Leseanfragen in einem festen Fenster von vier
Millisekunden. Ein Paket enthält höchstens 32 Operationen; die zusammengefassten
Eingaben belegen höchstens ein MiB. Größere Einzeloperationen werden separat
übertragen und unterliegen der Grenze ihres Endpunkts. Schreibanfragen warten
nur bis zum nächsten Microtask. Operationen verschiedener Anmeldesitzungen
werden getrennt, und jede Operation behält ihre eigene Berechtigungsprüfung.
Ein Transportpaket garantiert keine gemeinsame Transaktion. Die atomare
Veröffentlichung gehört ausdrücklich zu `zerotrust.access.publish`.

Aktuelle Schlüsselzertifikate werden mit `zerotrust.keyAuthorities.forAreas` für
bis zu 32 Bereiche in einem gemeinsamen, versionsgeprüften Stand gelesen. Die
API bündelt auch die zugehörigen Metadatenabrufe beim Datendienst. Alle Einträge
behalten ihre eigene Bereichs- und Empfängerprüfung; ein unzulässiger Eintrag
verwirft die gesamte Antwort. Der Client prüft deren Anzahl, Reihenfolge und
Signaturen. Beim Ausstellen von 35 Zertifikaten sind deshalb zwei begrenzte
Veröffentlichungen und zwei Nachprüfungen nötig, statt die 35 Zertifikate einzeln
nachzulesen. Auch vorbereitete Schlüsselwechsel verwenden diesen Sammelabruf.

Für höchstens 16 gezielt bearbeitete Bereiche werden nur deren Nachweise und
offene Schlüsselwechsel nachgelesen. Größere Auswahlen und die allgemeine
Fortsetzung prüfen das gesamte Verzeichnis. Eine zwischenzeitlich geänderte
Regelversion erfordert eine neue Empfängerauswahl. Konflikte bei unveränderten
Regeln und Schlüsselgenerationen werden höchstens zweimal wiederholt.

Der Abruf eines einzelnen Werkzeugs fragt dessen Stammdaten und Kosten gemeinsam
gezielt ab. Dafür wird nicht das gesamte Berechtigungsverzeichnis geladen.
Auch WebSocket-Hinweise für neue Schlüsselgenerationen führen zunächst zu einer
erneuten serverseitigen Prüfung von Sitzung und Rechten. Bleibt der Zugriff
gleich, laden die Clients nur die betroffenen Bereiche neu. Ändern sich Rechte,
Rollen oder die erlaubten Bereiche, wird der gesamte Zugriffskontext erneuert;
bei einem Entzug werden die betroffenen laufenden Arbeiten verworfen.

Eine schreibende Transaktion prüft das äußere Schema, aktuelle Rechte und die
maßgeblichen öffentlichen Ausgangsversionen. Sie sperrt die relevante
Regelversion gegen gleichzeitigen Entzug. Erst dann werden Chiffrat und neue
Objektversion gespeichert. Ein Rechteentzug verwendet denselben
Sperrmechanismus. Lokale Berechtigungscaches ersetzen diese Prüfung nicht. Für
große Objekte werden zunächst verschlüsselte Blöcke hochgeladen und anschließend
verbindlich referenziert. Eine fachliche Prüfung des verborgenen Inhalts ist
damit nicht nachgewiesen.

Ein dauerhaftes Änderungsjournal im gemeinsamen Datendienst ermöglicht den
Abgleich zwischen API-Instanzen. Die bisherige PostgreSQL-Benachrichtigung wird
dadurch ersetzt. Nach einer Unterbrechung wird der dauerhafte Stand nachgelesen;
Nachrichten-IDs verhindern eine doppelte Annahme. Die API verteilt
verschlüsselte CRDT-Änderungen und führt sie nicht selbst zusammen. Berechtigte
Clients erzeugen zusammengefasste Stände. Empfänger prüfen deren Herkunft und
ihre lesbaren Inhalte erneut. Einzelne Tastendrücke benötigen keine vollständige
Dokumentverschlüsselung.

Asymmetrische Schlüsselverteilung erfolgt bei Identitäts- und Rechteänderungen,
nicht für jeden Datenblock an jeden Benutzer. Die Speichergröße für Schlüssel
wächst damit im Wesentlichen mit den Datenblöcken sowie der Anzahl von Bereichen
und berechtigten Benutzern. Lokale Eingaben werden sofort dargestellt;
Übertragung und Signaturen können kurze Änderungsfolgen bündeln. Ihre
Persistenzbestätigung bleibt vom lokalen Bearbeitungszustand unterscheidbar.

Signierte Versionen und lokal bekannte Höchststände erkennen bestimmte
Manipulationen und Rücksetzungen. Sie garantieren weder Verfügbarkeit noch auf
einem neuen Gerät ohne weiteren Vertrauensanker die Erkennung jeder alten
Sicherung. Die absichtliche Löschung des Speichers durch den Betreiber bleibt
möglich. Reguläres Löschen erfordert weiterhin ein eigenes Löschrecht und eine
signierte Löschoperation.

## Suche, Auswertungen und LLM-Funktionen

Clients synchronisieren die für sie berechtigten Daten schrittweise und pflegen
lokale Suchindizes. Für vollständige Suche ohne vorherige lokale
Synchronisierung wäre später ein privater Datendienst möglich. Im ersten Ausbau
bleibt diese Suche vom synchronisierten Index des Clients abhängig.
Kryptografie, Indexierung und Auswertungen laufen außerhalb des Rendering-Pfads.
Häufig benutzte Schlüssel werden für die entsperrte Sitzung vorgehalten.
Persistente lokale Daten und Indizes werden verschlüsselt; nach Rechteentzug
werden betroffene Ansichten und lokale Caches im vertrauenswürdigen Client
entfernt. Das widerruft keine zuvor kopierten Informationen.

Eine Suchanfrage wird entweder vollständig von einem lokalen Index oder von
einem dafür vorgesehenen Suchdienst beantwortet. Serverseitige Treffer werden
weiterhin nicht nachträglich anhand von Anzeigenamen gefiltert. Ein lokaler
Index darf Treffer nur für seinen tatsächlich synchronisierten Bestand
behaupten; fehlende Bereiche werden nachgeladen oder als noch nicht durchsucht
angezeigt.

Die lokale Auswertungsengine ist DuckDB-Wasm. Sie läuft in einem Worker und hält
entschlüsselte Tabellen ausschließlich im Arbeitsspeicher. Feldtypen und
Prüfbedingungen sind im fachlichen Browserschema festgelegt. Der Server
verwendet den gemeinsamen DuckDB-Datendienst ohne frühere PostgreSQL-Prozeduren
oder Trigger. Die Suchbedeutung wird gesondert geprüft. Beliebige SQL-Abfragen
über geheime Werte kann die API ohne Klartextzugriff nicht unverändert weiter
ausführen. Sie kann technische Eindeutigkeit und Versionen sichern, aber keine
verschlüsselten Rechnungsbeträge nachrechnen. Fachliche Berechnungen und
Prüfungen laufen in den berechtigten Clients; der Server kann deren Ergebnisse
nicht vollständig nachprüfen.

Aufgerufene LLM-Funktionen erhalten die für ihren Zweck nötigen Klartextinhalte.
Das ist Teil des jeweiligen Workflows und benötigt keinen zusätzlichen Dialog
für jeden Tool-Aufruf. Chat und Dokumenteinlesen verwenden weiterhin
authentifiziertes MCP mit Benutzer-, Mandanten- und Sitzungsprüfung sowie der
vorhandenen begrenzten Delegation für Katalogsuchen.

Da der MCP-Server die verschlüsselten Geschäftsdaten nicht selbst öffnen kann,
liefert der zugehörige aktive Client erlaubte Suchergebnisse und Dokumentinhalte
über eine sitzungsgebundene Verbindung zu. Ein späterer abgeschirmter
Datendienst könnte ebenfalls einen ausdrücklich auf den LLM-Workflow begrenzten
Klartextkontext bedienen. Diese vom Benutzerclient signierte Delegation bindet
Zweck, Empfänger, Inhaltsbereiche, Sitzung und kurze Gültigkeit. Sie ist kein
allgemeines Entschlüsselungsrecht des MCP-Servers. Ohne geeigneten Client,
gültige Dienstdelegation oder bereits freigegebenen temporären Kontext kann der
Server diese Suche nicht ausführen. Es werden keine Mandanten- oder
Bereichsschlüssel an den LLM-Dienst übergeben. Ein Rechteentzug beendet
betroffene Delegationen und temporäre Kontexte.

Dauerhaft gespeicherte Chatverläufe und Tool-Ergebnisse werden wieder
clientseitig verschlüsselt; Klartextkontexte haben eine begrenzte Lebensdauer.
Bereits übermittelte Inhalte lassen sich beim Betreiber oder Modellanbieter
nicht kryptografisch zurückrufen. Bestehende Bestätigungen für vorgeschlagene
Fachaktionen bleiben erhalten. Der LLM-Pfad darf keine Rollen- oder
Schlüsselfreigaben erteilen und keine fehlenden Benutzerrechte ersetzen.

## Einführung und Nachweise

Zuerst wird die Regelprüfung vereinheitlicht und um Geltungs- und
Inhaltsbereiche ergänzt. Tests legen die Zuordnung der bestehenden Rollen fest,
einschließlich persönlicher und projektbezogener Zugriffe. Danach folgen
Anmeldung, Gerätezulassung und Wiederherstellung. Erst auf dieser Grundlage
werden native GAEB-Dokumente, kaufmännische Datensätze und die zugehörige
Zusammenarbeit verschlüsselt. Weitere Fachbereiche werden anschließend nach
denselben Regeln umgestellt.

Das neue System läuft unabhängig von der vorherigen Installation. Ein neuer
Mandant kann
[aus einer alten Sicherung eingerichtet werden](bestandsumstellung.md). Die
Quelle wird dabei im Browser gelesen, geprüft und vor der Übertragung
verschlüsselt. Eine laufende PostgreSQL-Anbindung, gemeinsame Umschaltsperren
und ein Mischbetrieb alter und neuer Mandanten gehören nicht zum Zielaufbau.
Alte Klartextsicherungen werden durch den Import nicht nachträglich geschützt.

Vor einer Freigabe müssen insbesondere folgende Fälle nachgewiesen werden:

- Eine Sicherung der neuen DuckDB-Mandantendatei und ihrer verschlüsselten
  Dateien enthält weder Klartext noch durch Betreiber-Schlüssel entschlüsselbare
  Inhalte.
- Das Aufmaßteam kann Maßansätze gemeinsam ändern, aber weder über
  Originaldatei, PDF, Historie, Summe noch Suchindex an geschützte Preise
  gelangen.
- Manipulierte Rollen oder ausgetauschte Empfängerschlüssel erzeugen keine
  gültige Freigabe. Ein Leser kann keine gültig autorisierte Schreiboperation
  erzeugen.
- Ein berechtigter Schreiber reicht unbekannte Felder, falsche Datentypen oder
  fachlich ungültige Inhalte ein. Ungültige äußere Felder werden serverseitig
  abgelehnt; ungültige entschlüsselte Inhalte werden im Client zurückgewiesen.
  Eine weitergehende serverseitige Garantie wird dabei nicht behauptet.
- Eingeschränkte Clients überschreiben keine verborgenen XML-Bestandteile.
  Unbekannte Elemente und Attribute überstehen einen vollständigen Round-Trip.
- Ein Rechteentzug während eines Schreibzugriffs wird über zwei unabhängige
  API-Instanzen korrekt geordnet. Alte Tickets und offline aufbewahrte
  Änderungen umgehen die neue Regel- und Schlüsselgeneration nicht.
- Ein neu ausgeschlossener Leser kann neue Inhalte nicht mit einem alten
  Bereichs- oder Datenschlüssel öffnen. Alternative Gruppenfreigaben und
  ausdrückliche Sperren werden dabei mitgeprüft.
- Ein neues Gerät, Passwortwechsel und Wiederherstellung funktionieren ohne
  Betreiberzugriff auf Schlüssel; ein Support-Reset allein öffnet keine Daten.
- Das LLM erhält ausschließlich Inhalte innerhalb der Benutzerrechte und seiner
  Delegation. Gespeicherte Verläufe enthalten keine ungeschützten Kopien.
- Tippen, gemeinsames Bearbeiten, Suche, erste Synchronisierung und große
  Projekte werden auf schwächeren Geräten gemessen und mit dem bisherigen
  Verhalten verglichen. Performancewerte werden erst nach diesen Messungen
  zugesagt.

Proton Drive beschreibt einen verwandten Ansatz aus Freigaben, getrennten
Schlüsseln und geprüften Inhalten in seinem
[Sicherheitsmodell](https://proton.me/blog/protondrive-security). Dieser Entwurf
überträgt das Prinzip auf die fachlichen Lese- und Schreibgrenzen von sortsys;
das konkrete Protokoll benötigt vor dem produktiven Einsatz eine unabhängige
Sicherheitsprüfung.
