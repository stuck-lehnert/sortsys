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

Bei einer Ausgabe werden die aktive Buchung des Werkzeugs und der neue
Buchungsdatensatz gemeinsam veröffentlicht. Eine Umbuchung beendet die alte
Buchung, legt eine Fortsetzung an und übernimmt die aktuellen Nutzungskosten.
Die Kosten der vorherigen Buchung bleiben erhalten. Rückgabe und Ablehnung
offener Umbuchungsanfragen erfolgen ebenfalls gemeinsam. Eine Rückgabe benötigt
keinen Kostenschlüssel.

Für die [Projektkosten](verschluesselte-projektkosten.md) enthalten die
Projektbereiche eine zusätzliche verschlüsselte Sicht auf ihre Werkzeugnutzung.
Buchungsdaten und historische Preise bleiben darin getrennt. Änderungen an der
ursprünglichen Buchung und dieser Sicht werden gemeinsam veröffentlicht. Eine
Kostenfreigabe für eine Baustelle öffnet dadurch keine Buchungen anderer
Projekte. Ausgabe, Rückgabe und Umbuchung benötigen die jeweils betroffenen
Schreibrechte auch im Projektbereich.

Die Bestandsumstellung übernimmt Werkzeugdaten, einzelne Buchungen, Inventuren
und Umbuchungsanfragen aus dem geprüften Archiv. Vorhandene identische Pakete
werden wiederverwendet. Abweichende Zielinhalte werden nicht überschrieben.
Datentypen und SQL-Bedingungen prüft der Browser anhand des gemeinsamen Schemas;
die API prüft Signaturen, Schreibrechte und technische Versionsstände.

Die Umstellung ist noch nicht vollständig:

- Die automatische Vergabe und Entziehung der Mitarbeiterfreigaben bei einer
  neuen Zuständigkeit fehlt. Die einzelnen Schlüsselbereiche und die
  administrativen Freigabefunktionen sind vorhanden; deren Bedienoberfläche
  fehlt noch.
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
