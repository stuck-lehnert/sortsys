# Kunden und Ansprechpartner im verschlüsselten Arbeitsbereich

Kunden und Ansprechpartner verwenden die bisherigen Listen und Formulare.
Ein Baubetrieb kann beispielsweise einen Auftraggeber über die Baustellenadresse
suchen, die Bauleitung als Ansprechpartner hinterlegen und deren Telefonnummer
ändern. Namen, Anschriften und Kontaktdaten werden im Browser entschlüsselt und
geprüft. Suchbegriffe und Formularwerte gelangen dabei nicht zur API.

Kunden und Ansprechpartner haben getrennte Schlüsselbereiche. Ein Benutzer kann
Kunden lesen, ohne die Anschriften oder Telefonnummern der Ansprechpartner öffnen
zu können. Auch der Produktkatalog und seine Preise bleiben unabhängig davon.
Unter **Verwaltung → Organisation → Datenschutz** lassen sich für jeden der
beiden Bereiche Lese- oder Schreibrechte vergeben. Eine
[Einladung](benutzerfreigaben.md) kann diese Freigaben ebenfalls bereitstellen.

## Zuordnungen und gleichzeitige Änderungen

Eine Zuordnung liegt verschlüsselt beim Kunden. Die Anzeige der zugehörigen
Ansprechpartner benötigt beide Lesefreigaben. Beim Hinzufügen oder Ersetzen
liest die Webapp den Kontaktbestand erneut und prüft die ausgewählten Einträge.
Die Speicherung bindet sowohl den Kundenstand als auch den gelesenen
Kontaktstand an dieselbe Transaktion. Ändert eine andere Anmeldung inzwischen
einen dieser Bestände, muss die Zuordnung erneut geprüft werden.

Die API kann diese Versionsprüfung auch über mehrere Instanzen durchführen.
Sie sperrt die beteiligten Bereiche in einer festen Reihenfolge und prüft die
aktuellen Leserechte für zusätzliche Vergleichsstände. Sie kennt weder die
Zuordnung noch die Kontaktwerte. Ein fremder Bereich lässt sich deshalb nicht
ohne Lesefreigabe als Vergleichsstand verwenden.

Andere geöffnete Ansichten erhalten technische
[Änderungshinweise](verschluesselte-synchronisierung.md). Eine Kontaktänderung
baut den Produktkatalog nicht neu auf. Nach einer Speicherung liest die Webapp
das verschlüsselte Objekt erneut und vergleicht seine Signatur mit dem
gesendeten Stand. Eine verlorene Antwort kann dadurch als bereits erfolgte
Speicherung erkannt werden; eine bloße Erfolgsantwort ohne gespeicherten Stand
reicht nicht aus.

## Datenprüfung und Löschung

Die Browser-Datenbank übernimmt Spalten, Typen, Prüfbedingungen und eindeutige
Schlüssel aus dem erzeugten Datenschema. Sie prüft zusätzlich die Felder von
Adressen und Kommunikationskanälen. Verweise auf Benutzer und auf den getrennten
Kontaktbestand werden beim bloßen Lesen eines Kunden nicht aufgelöst. Dafür
müssten sonst weitere private Bereiche geöffnet werden. Bei einer neuen
Kontaktzuordnung wird das Ziel im berechtigten Browser geprüft.

Löschen schreibt derzeit eine signierte, verschlüsselte Löschmarkierung. Ein
gelöschter Eintrag erscheint weder in der Liste noch als auswählbarer Kontakt.
Zuordnungen zu gelöschten Ansprechpartnern werden ausgeblendet. Bereits
gespeicherte verschlüsselte Fassungen und Verweise werden dadurch noch nicht
physisch entfernt. Die weitere Bereinigung, insbesondere von Projektverweisen,
muss mit den noch ausstehenden Projektadaptern umgesetzt werden.

Die [Grenzen fachlicher Prüfungen](verschluesselung-datenpruefung.md) gelten
weiterhin: Ein berechtigter, veränderter Client kann fehlerhafte Inhalte
signieren. Die API erzwingt technische Berechtigungen und Versionsstände,
aber keine geheimen Feldwerte. Auch eine Löschmarkierung lässt sich für den
Server nicht von einer anderen verschlüsselten Inhaltsänderung unterscheiden.
Der normale Client verlangt dafür zusätzlich die Löschfreigabe.

Die Suche umfasst Namen, Anreden, Adresswerte, Telefonnummern und E-Mail-Adressen.
Sie verbindet Wortanfänge mit einer UND-Verknüpfung. Eine vollständige Gleichheit
mit der bisherigen PostgreSQL-Textsuche, etwa bei URL-Zerlegung oder Satzzeichen,
ist damit noch nicht nachgewiesen. Projektzuordnungen und die übrigen
Fachbereiche sind ebenfalls noch umzustellen.

Die Namenssortierung verwendet derzeit den Vergleich des Browsers. Ihre
Reihenfolge bei Umlauten und Sonderzeichen kann von der bisherigen
Datenbank-Sortierung abweichen und gehört ebenfalls zum noch offenen Vergleich.

Der [Integrationstest](../sortsys-webapp-v2/scripts/test-live-address-book.ts)
vergleicht den übernommenen Bestand mit den bisherigen API-Ergebnissen und
prüft Bearbeitung, Zuordnungen, konkurrierende Änderungen und Speicherantworten.
