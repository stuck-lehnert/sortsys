# Mandanten mit einer Seed-Phrase wiederherstellen

Die Wiederherstellung verwendet das
[Verschlüsselungs- und Berechtigungsmodell](verschluesselung-und-berechtigungen.md)
und die gemeinsamen Bausteine aus
[`sortsys-zerotrust`](../sortsys-zerotrust/README.md). Die Webapp enthält die
Einrichtung des Notfallzugangs unter Verwaltung → Organisation → Datenschutz und
die Wiederherstellungsseite unter `/auth/recovery`. Sie benötigt kein geöffnetes
Administratorkonto und kein zuvor eingerichtetes Gerät. Den geprüften Umfang und
verbleibende Lücken führt der
[Funktionsabgleich](verschluesselung-funktionsabgleich.md) auf.

Die Wiederherstellungsphrase ist eine Sicherung der Administration. Normale
Benutzer müssen weder eine Phrase aufbewahren noch Schlüssel verwalten. Ihre
Anmeldung und die Freigaben für Projekte und Dokumente sollen wie gewohnt
funktionieren; notwendige Schlüsselwechsel übernimmt die Anwendung.

## Was die Phrase wiederherstellt

Bei der Einrichtung erzeugt der Browser 256 zufällige Bits und stellt sie als 24
Wörter mit Prüfsumme dar. Dafür eignet sich die Kodierung aus
[BIP-39](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki). Die
Wörter werden zufällig vorgegeben; ein selbst gewählter Satz ist ungeeignet. Es
gibt weder eine Wallet-Anbindung noch eine zusätzliche, leicht vergessene
Wallet-Passphrase. Das versionierte Recovery-Format legt Kodierung und
Schlüsselableitung eindeutig fest.

Aus dem Geheimnis werden getrennte Schlüssel für den Recovery-Nachweis und die
Entschlüsselung des Recovery-Katalogs abgeleitet. Die Ableitung bindet Zweck,
Mandanten-ID und Recovery-Generation ein. Die API speichert die öffentlichen
Schlüssel, die aktuelle Generation und verschlüsselte Wiederherstellungsdaten.
Die Wörter und privaten Recovery-Schlüssel verlassen den Browser nicht.

Die Phrase ist der einzige Notfallnachweis für diese mandantenweite Recovery.
Weder ein bestehendes Passwort noch ein vorhandenes Gerät, eine E-Mail-Adresse,
ein MFA-Code oder die Zustimmung des Providers sind dafür erforderlich. Die
Mandantenkennung und ein passender verschlüsselter Datenbestand sind notwendige
Zuordnungs- beziehungsweise Sicherungsdaten, aber keine weiteren Geheimnisse.

Es gibt keinen Provider-Hauptschlüssel, keinen vom Provider entschlüsselbaren
Recovery-Escrow und keinen Support-Endpunkt, der den Nachweis ersetzen darf.
Insbesondere darf der Provider keinen privaten Recovery-Schlüssel besitzen, auch
nicht als mit einem eigenen KMS-Schlüssel entschlüsselbare Kopie. Ein
betreiberseitiger Administrator- oder Datenbankzugang stellt keine
Wiederherstellungsberechtigung dar.

Der aktive Recovery-Vertrauensanker wird bei der Einrichtung im Client
bestätigt. Jeder spätere Wechsel erfordert einen Nachweis mit dem bisherigen
privaten Recovery-Schlüssel. Normale Mandantenadministration und selbst die
betriebliche Signaturautorität können diesen Nachweis nicht ersetzen. Clients
prüfen die Wechselkette, statt neue Recovery-Schlüssel aus einer
Datenbankantwort ungeprüft zu übernehmen. Ein eingetragener Provider-Schlüssel
erhält so auch keinen Zugriff auf künftig erzeugte Bereichsschlüssel.

Der Recovery-Katalog enthält die für die Wiederherstellung benötigten
betrieblichen Bereichsschlüssel, einschließlich noch benötigter historischer
Generationen. Er enthält keine Passwörter oder privaten Identitätsschlüssel
anderer Benutzer. Eine Recovery stellt den Zugriff auf betriebliche Inhalte
wieder her; sie übernimmt nicht die Identität aller Mitarbeiter.

Die Wiederherstellungsseite behält standardmäßig das bestehende primäre
Administratorkonto bei. Anmeldename und Benutzerkennung bleiben erhalten;
Passwort und private Schlüssel werden neu eingerichtet. Das Konto behält sein
Personalprofil und seine historischen Urheberzuordnungen. Die Signaturen
früherer Schlüsselgenerationen bleiben über die geprüfte Vertrauenskette
nachweisbar. Ein gelöschtes, archiviertes oder deaktiviertes Konto wird dabei
nicht wieder aktiviert. Ist es nicht mehr verfügbar, kann ausdrücklich ein
neues Administratorkonto angelegt werden.

Ein vorhandenes Mitarbeiterpasswort bleibt von der Mandantenfreigabe getrennt.
Nach einer Recovery müssen die anderen Konten unter der neuen Mandantenautorität
erneut eingeladen und bestätigt werden. Die Rechteverwaltung bietet für diese Konten
die Einladung an, auch wenn bereits ein Passwort besteht. Nach der Bestätigung
gelten die neu erteilten Rechte; frühere Buchungsfreigaben werden nicht pauschal
wiederhergestellt. Auch technische Rollen der vorherigen Autorität werden bei
dieser erneuten Bestätigung entfernt. Ein ehemaliger Administrator wird durch
eine normale Mitarbeitereinladung deshalb nicht wieder zum Administrator. Die
erneute Ausstellung eines bereits aktuellen Zertifikats lässt dagegen dessen
bestehende Rollen unverändert.

Neue kryptografische Bereiche dürfen nur zusammen mit einem für den aktuellen
öffentlichen Recovery-Schlüssel verschlüsselten Schlüsselpaket veröffentlicht
werden. Die Transaktion prüft die Recovery-Generation und verhindert, dass ein
gleichzeitiger Wechsel eine Lücke im Katalog hinterlässt. Der erzeugende Client
verantwortet das korrekte Paket. Prüfungen müssen dessen Erzeugung und eine
echte Entschlüsselung mit der Phrase abdecken.

Die API legt das verschlüsselte Schlüsselpaket vor der Veröffentlichung des
Bereichs ab. Scheitert danach die Mandantentransaktion, kann ein unbenutzter
Entwurf zurückbleiben. Ein erneuter Versuch darf diesen Entwurf ersetzen.
Bereits veröffentlichte Schlüsselgenerationen bleiben unveränderlich. Die
Recovery berücksichtigt nur veröffentlichte Bereiche und Generationen; ein
abgebrochener Einrichtungsversuch darf sie nicht blockieren.

Die Phrase verleiht Zugriff auf sämtliche vom Mandanten als betrieblich
wiederherstellbar eingestuften Bereiche, auch auf die interne Kalkulation. Sie
gehört deshalb in einen Tresor oder eine vergleichbare Aufbewahrung außerhalb
von sortsys. Kontoverwaltung allein berechtigt nicht zum Abrufen einer
vorhandenen Phrase. Eine neue Phrase ist ein neues Geheimnis und kann erst nach
einem mit der bisherigen Phrase bestätigten Wechsel aktiv werden. Geht die
Phrase verloren, kann auch ein noch angemeldeter Administrator sie nicht durch
einen Recovery-Reset des Providers ersetzen. Ein eingerichteter Benutzer kann
weiter seine regulären Datenrechte ausüben; das ist kein Notfallzugang.

## Einmalige Nutzung und neue Phrase

Jede erfolgreiche Notfallwiederherstellung verbraucht die aktuelle
Recovery-Generation. Die neue Phrase wird unabhängig und zufällig erzeugt; sie
darf nicht aus der alten ableitbar sein. Eine Generation kann genau einen
Wiederherstellungsvorgang starten, auch bei gleichzeitigen Anfragen an mehrere
API-Instanzen.

Der Browser bereitet den vollständigen neuen Stand vor. Die API veröffentlicht
ihn anschließend in einer einzigen Transaktion in der DuckDB-Mandantendatei.

1. Die bisherige Phrase wird ausschließlich im Browser eingegeben. Dieser prüft
   Wortliste und Prüfsumme und öffnet den verschlüsselten Recovery-Katalog.
2. Der Browser erzeugt eine unabhängige neue Phrase, neue Administratorschlüssel
   und eine neue Signaturautorität. Die neue Phrase wird vor dem verbindlichen
   Start gesichert und durch eine lokale Wortabfrage bestätigt. Das neue Passwort
   wird über OPAQUE vorbereitet, auch beim Beibehalten der Benutzerkennung.
3. Der Client verpackt die bisherigen Schlüssel für die neue Phrase. Größere
   Kataloge werden als verschlüsselte Seiten abgelegt und vor der
   Veröffentlichung zurückgelesen. Dabei erhält die API keine Schlüssel im
   Klartext.
4. Eine kurzlebige Challenge bindet den signierten Plan an Mandant, Generation,
   Katalogversion, neue öffentliche Schlüssel und den neuen Recovery-Katalog.
   Auch der neue Recovery-Schlüssel bestätigt diesen Plan. Eine Signatur kann
   weder auf ein anderes Konto noch auf einen anderen Katalog übertragen werden.
5. Die gemeinsame Transaktion prüft den aktuellen Stand und die vollständige
   Abdeckung aller veröffentlichten Schlüsselgenerationen. Sie speichert das
   erneuerten Kontozugang, die neue Autorität, Richtlinien, Bereichsschlüssel und
   historische Schlüsselzugänge. Gleichzeitig verbraucht sie die Challenge und
   widerruft sämtliche bisherigen Sitzungen.
6. Der Datendienst sichert den vorbereiteten Auftrag in `control.duckdb`,
   veröffentlicht ihn in der Mandantendatei und bestätigt anschließend die
   unabhängigen Versionsnachweise. Erst danach meldet die Anfrage Erfolg.
   Unterbrechungen werden anhand desselben Auftrags fortgesetzt. Die bisherige
   Phrase kann dann keinen weiteren Vorgang starten. Ein konkurrierender Plan
   verliert seine Versionsprüfung und veröffentlicht keine Teiländerungen.

Der fertige Plan wird in hashgeprüften Teilen von höchstens 128 KiB übertragen.
Jeder Teil benötigt den Seed-Nachweis für denselben Vorgang. Eine andere
API-Instanz kann die Übertragung fortsetzen; fehlende oder abweichende Teile
verhindern die Veröffentlichung. Die temporären Datensätze verändern keine
aktiven Konten oder Schlüssel und laufen mit der Challenge ab. Der Transport
erlaubt je Challenge genau ein Manifest mit höchstens 512 Teilen und 64 MiB.
Ein anderer Wiederherstellungsvorgang benötigt eine neue Challenge. Die Prüfung
des vollständigen Schlüsselbestands erlaubt vorerst höchstens 2.000 Bereiche
und 50.000 Schlüsselstände. Das Berechtigungsmodell begrenzt die Bereichszahl
weiterhin unabhängig von der übertragenen Paketgröße.

Beim Beibehalten eines Kontos enthält der signierte Plan außerdem einen
Prüfwert seines technischen Stands. Dieser bindet auch Passwortregistrierung,
Anmeldenamen und Kontostatus. Die API prüft ihn vor der Registrierung und erneut
innerhalb der Veröffentlichungstransaktion. Eine parallele Kontoänderung über
eine andere Instanz verwirft den alten Plan; sie wird nicht überschrieben. Der
Browser liest den aktuellen Stand bei einem erneuten Versuch neu ein. Solange
kein Wechsel veröffentlicht wurde, bleibt die bisherige Phrase gültig.

Die API führt dafür einen geschützten Bestandszähler. Neue Bereiche,
Schlüsselwechsel und Recoveries aktualisieren ihn gemeinsam mit den
Schlüsselveröffentlichungen. Auch historische Generationen zählen weiter.
Vor einer Recovery vergleicht die API den Zähler mit dem vollständigen
veröffentlichten Bestand. Abweichungen und überschrittene Kapazitäten verhindern
den Commit. Die aktuelle Phrase und die bisherigen Konten bleiben dann aktiv.
Die gemeinsame Kapazitätsprüfung hält außerdem Platz für eine weitere
vollständige Schlüsselrotation frei. Das hebt die Gesamtgrenze nicht auf.

Beim Lesen einer Bestandsseite lädt die API die referenzierten Bereiche und
Schlüsseldefinitionen gemeinsam aus dem Datendienst. Vor dem Veröffentlichen
liest sie auch die Schreibziele und deren unabhängige Sicherheitsnachweise in
begrenzten Sammelanfragen. Die Versionsprüfung umfasst weiterhin jeden
Datensatz, einschließlich zuvor nicht vorhandener Einträge. Ändert eine zweite
API-Instanz währenddessen einen dieser Stände, wird die gesamte Veröffentlichung
abgewiesen.

Der Browser prüft zusätzlich die signierte Definition der jeweils angegebenen
aktuellen Bereichsgeneration. Sie bindet die Bereichszuordnung und den Inhaltstyp
an die exakte Recovery-Hülle. Eine veränderte Zuordnung kann dadurch nicht allein
mit einem unveränderten Schlüsselpaket in den neuen Plan übernommen werden.
Auch historische Verwalter- und Anlagenachweise werden geprüft. Diese Prüfung
beginnt vor der Registrierung des erneuerten Administrationszugangs; Vollständigkeit
und Versionsstand prüft weiterhin die gemeinsame Veröffentlichung.

Auch nach einer positiven Erfolgsantwort liest der Browser die veröffentlichte
Autorität erneut und prüft Signatur, Generation und die Bindung an den eigenen
vorbereiteten Plan. Eine bloße Erfolgsantwort bestätigt keine abgeschlossene
Wiederherstellung.

Der Administrationszugang erhält einen privaten Bereich für seine
Einladungen. Persönliche Verläufe bleiben den jeweiligen Benutzerkonten
zugeordnet. Bestehende Mitglieder können über eine neue Einladung erneut
freigegeben werden und melden sich dabei mit ihrem vorhandenen Passwort an. Die
Freigabe umfasst auch frühere Schlüsselgenerationen ihres eigenen KI-Bereichs,
damit übernommene Chats nach der Wiederherstellung lesbar bleiben. Sie öffnet
keinen fremden persönlichen Verlauf. Die Mandanten-Recovery selbst benötigt
dafür kein Passwort eines bisherigen Mitglieds.

Das Signieren einer Challenge ist ein Besitznachweis. Die API erfährt dadurch
weder die Phrase noch den Entschlüsselungsschlüssel. Erratbare
Mandantenkennungen oder die bloße Anforderung einer Challenge dürfen keine
Generation verbrauchen und den Betrieb nicht sperren. Kurzlebige Challenges,
begrenzte Nachrichten und höchstens 128 gleichzeitig gültige Challenges pro
Mandant begrenzen den gespeicherten Zustand. Die Phrase hat 256 Bit zufällige
Entropie; es gibt keinen erratbaren Recovery-Code mit wenigen Stellen.

Ein Abbruch vor dem Commit lässt den bisherigen Stand unverändert. Geht nur die
Antwort nach dem Commit verloren, prüft der Browser die veröffentlichte neue
Generation. Die Recovery-ID bestätigt ausschließlich den bereits gespeicherten
Plan; sie erlaubt keinen anderen Administrator und liefert keinen
Sitzungsschlüssel. Das Konto meldet sich anschließend mit seinem im Browser
eingerichteten OPAQUE-Passwort an. Benachrichtigungen aktualisieren die
Oberfläche; die Versionsprüfung des Datenspeichers entscheidet über die
Gültigkeit einer Anfrage.

## Schlüssel nach einer Recovery wechseln

Nur den Recovery-Katalog für neue Wörter zu verpacken wäre unzureichend. Die
alte Phrase könnte bereits eine Kopie der bisherigen Bereichsschlüssel
erschlossen haben. Deshalb werden alle betroffenen Bereichsschlüssel unabhängig
neu erzeugt. Neue Datenversionen erhalten neue Datenschlüssel und werden
ausschließlich unter der neuen Generation verpackt. Neue Geheimnisse dürfen
weder unter alten Bereichsschlüsseln noch für alte Recovery-Schlüssel
veröffentlicht werden.

Die bisherige Signaturautorität bleibt nur zur Prüfung historischer Vorgänge
erhalten. Sie darf keine neuen Identitäten, Freigaben oder Geräte zulassen. Die
Administration bestätigt die weiter geltenden Benutzeridentitäten und Rechte
unter der neuen Autorität. Alte Administratorrechte werden dabei nicht ungeprüft
übernommen. Benutzerkonten können mit ihren bisherigen Passwörtern erhalten
bleiben; ihre Schlüsselpakete werden erst nach erneuter Bestätigung
veröffentlicht. Kompromittierte Identitäten müssen ersetzt werden.

Die neue Richtlinie gibt zunächst ausschließlich dem wiederhergestellten
Administrationszugang Zugriff. Weitere Benutzer werden unter der neuen Autorität erneut bestätigt.
Historische Zertifikate bleiben für die Prüfung alter Inhalte erhalten,
berechtigen aber nicht zu neuen Schlüsselabrufen.

## Abbruch, Geräteverlust und zweite Wiederherstellung

Vor dem verbindlichen Generationswechsel bleibt die bisherige Phrase gültig.
Nach diesem Wechsel wird ausschließlich mit der neuen Phrase oder dem neuen
begrenzten Administratorzugang fortgesetzt. Der vorbereitete verschlüsselte
Katalog enthält den dafür nötigen Zustand. Eine unterbrochene Operation behält
dieselbe Recovery-ID und nimmt abgeschlossene Schritte wieder auf.

Die Fortsetzung einer laufenden Operation verbraucht nicht erneut eine Phrase.
Ein neuer Recovery-Vorgang nach Abschluss dagegen erfordert die dann aktuelle
Phrase und erzeugt erneut eine unabhängige neue Phrase. Wiederholte Requests
derselben Operation sind idempotent; eine neue Operation mit derselben alten
Phrase wird abgewiesen.

Die Oberfläche meldet Erfolg erst nach abgeschlossener Schlüsselumstellung und
erreichbarem neuem Administratorzugang. Ein Fehler nach dem ersten Commit darf
niemals mit der Aufforderung enden, erneut die bereits verbrauchte Phrase zu
verwenden. Bereits vor dem Commit gesicherte neue Wörter verhindern diese Lücke.

Ein Passwortreset für ein einzelnes Mitglied ist ein anderer Vorgang als die
mandantenweite Recovery. Dieser Ablauf ist noch nicht angeschlossen; ein
Betreiberreset darf keinen Zugang zu den privaten Kontoschlüsseln schaffen.

## Grenzen der Ungültigkeit und Wiederherstellung alter Sicherungen

„Ungültig nach Gebrauch“ bedeutet, dass die aktuelle Infrastruktur keinen
weiteren Recovery-Vorgang mit dieser Phrase akzeptiert. Nach der
Schlüsselumstellung öffnet sie außerdem keine erst danach entstandenen Inhalte.
Alte Datenkopien bleiben jedoch mit den damals gültigen Schlüsseln
entschlüsselbar. Eine Seed-Phrase kann einen einmal geöffneten Datenbestand
nicht nachträglich unlesbar machen.

Die Phrase ersetzt keine Datensicherung. Erforderlich bleiben die
verschlüsselten Daten, ihre technischen Metadaten und ein passender
verschlüsselter Recovery-Katalog. Nach einem Phrase-Wechsel kann eine alte
Sicherung unter Umständen nur zusammen mit dem neueren Recovery-Katalog geöffnet
werden. Dieser enthält deshalb die noch benötigten historischen
Bereichsschlüssel und muss zusammen mit dem aktuellen Recovery-Kopf unabhängig
gesichert werden.

Eine Wiederherstellung der Mandantendatei darf den unabhängig gesicherten
aktuellen Recovery-Stand nicht zurücksetzen. Beim Rückspielen werden Generation
und Status zuerst abgeglichen. Auch ein vollständiger Betriebsrestore muss den
höchsten bereits bestätigten Recovery-Stand aus einer unabhängig aufbewahrten
Sicherung oder Bestätigung übernehmen. Wenn sämtliche Sicherheitszustände auf
einen alten Stand zurückgesetzt werden und kein neuerer Vertrauensanker
verbleibt, lässt sich die einmalige Nutzung nicht mehr zuverlässig erkennen.

Der Datendienst verankert inzwischen die Recovery-Generation und den
maßgeblichen Rechte- und Schlüsselstand außerhalb der Mandantendatei. Ältere
oder fehlende Nachweise sperren den Zugriff. Das verhindert die erneute
Verwendung einer verbrauchten Phrase über eine allein zurückgespielte
Mandantendatei. Dazu bewahrt er den verschlüsselten Recovery-Kopf,
Kontozustände, signierte Richtlinien, Schlüsselumschläge und veröffentlichte
Katalogseiten unabhängig auf. Ein automatischer Rücksicherungsablauf, der den
älteren Fachbestand mit dem neuesten verschlüsselten Recovery-Katalog
zusammenführt, fehlt noch. Ein Dateisnapshot allein ist deshalb noch kein
geprüfter vollständiger Wiederherstellungsweg.

Bei der unabhängigen Aufbewahrung gehören die neue Phrase und der verschlüsselte
aktuelle Recovery-Katalog zum Wiederherstellungspaket. Weitere Geschäftsdaten
bleiben Bestandteil der regulären Sicherung. Der Recovery-Katalog wird nach
Änderungen an Bereichen oder Schlüsselgenerationen ebenfalls gesichert; seine
vertraulichen Inhalte bleiben unter dem aktuellen Recovery-Schlüssel geschützt.

## Nachweise vor produktiver Nutzung

Ein eigener Mehrinstanztest behält das primäre Administratorkonto bei. Er
verwirft vorbereitete Pläne nach Passwort- und Namensänderungen über eine zweite
API-Instanz. Nach zwei erfolgreichen Wiederherstellungen sind Benutzerkennung,
Personalprofil und verschlüsselte Artikel erhalten. Alte Passwörter und
verbrauchte Phrasen funktionieren nicht mehr. Ein Chromium-Test prüft außerdem
die Vorauswahl des bestehenden Kontos und die bewusste Entscheidung für ein
neues Konto, wenn der bisherige Zugang nicht verfügbar ist. Der native
Passkey-Test weist nach, dass eine zuvor funktionierende Passkey-Anmeldung
nach dem Wechsel auch unter derselben Benutzerkennung abgewiesen wird.

Der eigenständige DuckDB-Test verbindet den Webapp-Kryptografiecode mit zwei
API-Instanzen. Er prüft konkurrierende Pläne, verschlüsselte Katalogseiten und
zwei aufeinanderfolgende Recoveries. Verbrauchte Phrasen und alte Sitzungen
werden abgewiesen. Ein vorher gespeicherter Inhalt bleibt nach beiden Wechseln
lesbar. Auch eine verlorene Antwort nach dem Commit wird über den
veröffentlichten Stand aufgelöst. Die beobachteten Anfragen enthalten weder
Phrase noch Passwort oder Geschäftsinhalt im Klartext.

Der Test verändert außerdem Bereichszuordnungen und Inhaltstypen in den
Bestandsantworten, wahlweise auch in den mitgelieferten Definitionen. Der Browser
lehnt diese Antworten vor einer neuen Kontoregistrierung ab. Separate
Framework-Tests prüfen fehlende und doppelte Nachweise sowie eine andere gültig
signierte Recovery-Hülle neben einer unveränderten Definition.

Ein HTTP-Messtest veröffentlicht 600 geschützte Datensätze atomar. Für die
Schreibziele und ihre Sicherheitsnachweise benötigt er drei Leseanfragen.
Doppelte Schlüssel und wiederholtes Vorladen lösen keine weiteren Abrufe aus.
Konkurrierende Neuanlagen und Änderungen an einem Sicherheitsnachweis führen
zum Versionskonflikt; keiner der vorbereiteten Datensätze wird dabei verändert.

Der native Lasttest legt 96 Bereiche mit jeweils 105 Generationen über die
regulären API-Endpunkte an. Eine anschließende Seed-Recovery übernimmt alle
10.080 historischen Schlüsselstände. Die zuvor unter der ersten und letzten
Generation gespeicherten Inhalte bleiben lesbar; der geschützte Bestandszähler
enthält danach auch die neuen Recovery-Generationen. Der Test prüft damit
Schlüsselbestände oberhalb der früheren 10.000er-Grenze, aber keine größere
Zahl von Inhaltsbereichen.

Ein weiterer Mehrinstanztest erzeugt Schlüsselgenerationen mit dem eigenen
Signaturschlüssel eines beauftragten Bereichsverwalters. Neue Leser erhalten
historische Kopien; ein späterer Leserentzug erneuert die Schlüssel. Nachdem
auch dem Verwalter die Befugnis entzogen wurde, bleiben diese Inhalte nach zwei
Recoveries lesbar. Beide Wiederherstellungen beginnen ohne entsperrtes
Benutzerkonto und benötigen nur die jeweils gültige Phrase. Fehlende oder
veränderte Nachweise fremd signierter Recovery-Hüllen werden bereits vor der
Registrierung eines neuen Kontos abgelehnt.

Der Test enthält aktive und abgeschlossene Werkzeugbuchungen. Nach beiden
Recoveries bleiben deren Inhalte und Kosten für den neuen Administrator lesbar.
Eine Rückgabe mit anschließendem Schlüsselwechsel verhindert, dass alte
Mitarbeiterschlüssel spätere Änderungen öffnen. Zwischen den Recoveries wird
ein Mitarbeiter mit seinem bestehenden Passwort erneut eingeladen und bestätigt.
Er erhält Zugriff auf eine neue Ausgabe, ohne damit frühere Buchungen oder
Werkzeugkosten lesen zu können. Auch ein ehemaliger Administrator wird erneut
als gewöhnlicher Mitarbeiter eingeladen: Sein bisheriges Passwort funktioniert
weiter, sein Konto erhält dadurch aber keinen Zugriff auf die administrative
Mitgliederliste. Die Nachweise für weitere Arbeitsabläufe sind im
[Funktionsabgleich](verschluesselung-funktionsabgleich.md) aufgeführt.

Die unabhängige Generationssperre ist im Datendienst umgesetzt. Sein
[Wiederherstellungstest](../sortsys-store/src/witness.rs) weist eine alte
Mandantendatei nach einem Recovery-Wechsel zurück. Ein allgemeiner Ablauf, der
einen älteren Fachstand unter Erhalt der aktuellen Sicherheitsnachweise
wiederherstellt, fehlt weiterhin. Auch Bestände oberhalb der normalen
Sammelgrenzen benötigen einen erweiterten Schreibweg. Die folgenden Fälle
unterscheiden laufende Protokollprüfungen von noch nötigen Ausfalltests:

- Zwei API-Instanzen versuchen gleichzeitig dieselbe Phrase zu verwenden. Genau
  eine Operation startet; die andere darf weder einen zweiten Administrator
  erzeugen noch die neue Phrase überschreiben.
- Ein Stromausfall wird vor und nach jedem verbindlichen Schritt simuliert. Vor
  dem ersten Commit funktioniert die alte Phrase, danach die neue Phrase zur
  Fortsetzung. Die Daten bleiben wiederherstellbar.
- Neue kryptografische Bereiche entstehen gleichzeitig mit einer Recovery. Kein
  erfolgreich veröffentlichter Bereich fehlt im wiederherstellbaren Stand.
- Ein Angreifer kennt die alte Phrase und den alten Katalog. Nach Abschluss
  öffnen diese keine neuen Inhalte und erlauben keine neuen Freigaben.
- Eine ältere Tenant-Sicherung wird eingespielt. Die verbrauchte Phrase wird
  dadurch nicht erneut für die aktuelle Recovery gültig; die neue Phrase und der
  passende Recovery-Katalog erschließen die historischen Daten.
- Netzwerk-, Datenbank- und Protokollaufzeichnungen enthalten weder Wörter noch
  private Recovery-Schlüssel. Ein normaler Supportzugang reicht nicht zur
  Wiederherstellung aus.
- Ein Provider-Administrator ersetzt Recovery-Schlüssel in der Datenbank oder
  versucht einen Reset über E-Mail, MFA, Betreiber-JWT oder die normale
  Mandantenautorität. Kein Versuch erzeugt einen akzeptierten Wechsel oder
  erschließt Daten. Ohne gültige Phrase bleibt die Notfallwiederherstellung
  unmöglich.
