# Mandanten mit einer Seed-Phrase wiederherstellen

Dieser Entwurf ergänzt das
[Verschlüsselungs- und Berechtigungsmodell](verschluesselung-und-berechtigungen.md).
Die kryptografische Grundlage und die API sind im
[Draft](../sortsys-zerotrust/README.md) umgesetzt. Die Webapp enthält die
Einrichtung des Notfallzugangs unter Verwaltung → Organisation → Datenschutz und die
Wiederherstellungsseite unter `/auth/recovery`. Die Umstellung bestehender
Fachdaten und Dateien ist noch nicht abgeschlossen. Die Notfallwiederherstellung soll
auch dann funktionieren, wenn kein Administrator mehr sein Konto oder ein
eingerichtetes Gerät öffnen kann.

Die Wiederherstellungsphrase ist eine Sicherung der Administration. Normale
Benutzer müssen weder eine Phrase aufbewahren noch Schlüssel verwalten. Ihre
Anmeldung und die Freigaben für Projekte und Dokumente sollen wie gewohnt
funktionieren; notwendige Schlüsselwechsel übernimmt die Anwendung.

## Was die Phrase wiederherstellt

Bei der Einrichtung erzeugt der Browser 256 zufällige Bits und stellt sie als
24 Wörter mit Prüfsumme dar. Dafür eignet sich die Kodierung aus
[BIP-39](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki).
Die Wörter werden zufällig vorgegeben; ein selbst gewählter Satz ist ungeeignet.
Es gibt weder eine Wallet-Anbindung noch eine zusätzliche, leicht vergessene
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
Insbesondere darf der Provider keinen privaten Recovery-Schlüssel besitzen,
auch nicht als mit einem
eigenen KMS-Schlüssel entschlüsselbare Kopie. Ein betreiberseitiger
Administrator- oder Datenbankzugang stellt keine Wiederherstellungsberechtigung
dar.

Der aktive Recovery-Vertrauensanker wird bei der Einrichtung im Client bestätigt.
Jeder spätere Wechsel erfordert einen Nachweis mit dem bisherigen privaten
Recovery-Schlüssel. Normale Mandantenadministration und selbst die betriebliche
Signaturautorität können diesen Nachweis nicht ersetzen. Clients prüfen die
Wechselkette, statt neue Recovery-Schlüssel aus einer Datenbankantwort ungeprüft
zu übernehmen. Ein eingetragener Provider-Schlüssel erhält so auch keinen
Zugriff auf künftig erzeugte Bereichsschlüssel.

Der Recovery-Katalog enthält die für die Wiederherstellung benötigten
betrieblichen Bereichsschlüssel, einschließlich noch benötigter historischer
Generationen. Er enthält keine Passwörter oder privaten Identitätsschlüssel
anderer Benutzer. Eine Recovery stellt den Zugriff auf betriebliche Inhalte
wieder her; sie übernimmt nicht die Identität aller Mitarbeiter.

Neue kryptografische Bereiche dürfen nur zusammen mit einem für den aktuellen
öffentlichen Recovery-Schlüssel verschlüsselten Schlüsselpaket veröffentlicht
werden. Die Transaktion prüft die Recovery-Generation und verhindert, dass ein
gleichzeitiger Wechsel eine Lücke im Katalog hinterlässt. Der erzeugende Client
verantwortet das korrekte Paket. Prüfungen müssen dessen Erzeugung und eine echte
Entschlüsselung mit der Phrase abdecken.

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

Der Wechsel läuft in zwei Abschnitten ab. Die sofortige Sperre der alten Phrase
erfolgt beim verbindlichen Start; die anschließende Schlüsselumstellung kann
länger dauern.

1. Der Administrator öffnet die Wiederherstellung für seine Mandantenkennung und
   gibt die bisherige Phrase ausschließlich im Browser ein. Dieser prüft
   Wortliste und Prüfsumme und öffnet den verschlüsselten Recovery-Katalog.
2. Der Browser erzeugt eine neue Phrase, neue Administrator-Schlüssel und eine
   neue Signaturautorität für den Mandanten. Die neue Phrase wird vor dem
   verbindlichen Start gesichert und durch eine lokale Wortabfrage bestätigt.
   Das neue Administratorkonto wird über OPAQUE eingerichtet.
3. Der Client verschlüsselt einen fortsetzbaren Recovery-Katalog für die neue
   Phrase. Dieser enthält bereits die bisherigen Schlüssel, sodass ein Absturz
   nach dem Wechsel nicht den Zugriff auf alte Inhalte zerstört.
4. Die API stellt eine kurzlebige einmalige Challenge aus. Der Client signiert
   mit seinem bisherigen Recovery-Schlüssel den Mandanten, die Challenge,
   Recovery-ID, erwartete Generation und Katalogversion sowie die neuen
   öffentlichen Schlüssel und den Hash des vorbereiteten Recovery-Katalogs.
   Eine Signatur darf nicht für einen anderen Administrator oder einen anderen
   Katalog wiederverwendet werden.
5. Nach Prüfung des Nachweises setzt eine Transaktion in der Mandantendatenbank
   eine dauerhafte Schreibsperre für diesen Recovery-Vorgang. Sie prüft die
   erwartete Katalogversion und hinterlegt den vorbereiteten verschlüsselten
   Katalog. Bereits laufende Schreibzugriffe werden davor abgeschlossen;
   danach entstehen keine weiteren Bereiche oder Inhalte unter dem alten Stand.
6. Eine Transaktion in der Masterdatenbank sperrt den aktuellen Recovery-Kopf,
   prüft Nachweis und erwartete Versionen, verbraucht die Challenge und wechselt
   auf die neue Generation. Sie veröffentlicht den neuen verschlüsselten
   Katalog, die neue Autorität und den Status `rekeying`. Die alte Phrase ist
   damit für einen weiteren Start sofort ungültig.
7. Eine weitere Transaktion übernimmt ausschließlich den bereits signierten
   Plan in die Mandantendatenbank: neues OPAQUE-Konto, neue Autorität, neue
   Bereichsschlüssel und Zugänge zu historischen Schlüsseln. Sie widerruft
   bisherige Sitzungen. Erst danach wird der Recovery-Kopf wieder freigegeben.
   Ein nicht fertig umgestellter Mandant bleibt im Einrichtungsstatus;
   Recovery erklärt ihn nicht nachträglich für vollständig verschlüsselt.

Das Signieren einer Challenge ist ein Besitznachweis. Die API erfährt dadurch
weder die Phrase noch den Entschlüsselungsschlüssel. Erratbare
Mandantenkennungen oder die bloße Anforderung einer Challenge dürfen keine
Generation verbrauchen und den Betrieb nicht sperren. Kurzlebige Challenges,
begrenzte Nachrichten und höchstens 128 gleichzeitig gültige Challenges pro
Mandant begrenzen den gespeicherten Zustand. Die Phrase hat 256 Bit zufällige
Entropie; es gibt keinen erratbaren Recovery-Code mit wenigen Stellen.

Die Masterdatenbank ist der verbindliche Ort für die aktuelle Recovery-Generation.
Eine Transaktion über Master- und Mandantendatenbank wird nicht vorausgesetzt.
Stattdessen steht die dauerhafte Tenant-Schreibsperre bereits vor dem
Generationswechsel. Normale Commits sperren die entsprechende Tenant-Zeile
geteilt und prüfen ihren Status; das Vorbereiten einer Recovery sperrt sie
exklusiv. Alle Schreibwege verwenden dieselbe Sperrreihenfolge.

Ein Absturz zwischen beiden Datenbank-Commits lässt die Schreibsperre bestehen.
Die Recovery-ID erlaubt die Fortsetzung desselben unveränderlichen Plans.
Sie erlaubt weder einen anderen Administrator noch andere Schlüssel. Die
Fortsetzung gibt auch keinen Sitzungsschlüssel zurück; das neue Konto meldet
sich anschließend mit seinem im Client eingerichteten OPAQUE-Passwort an.
Ein Zurücksetzen auf die alte Generation ist nicht vorgesehen.
Eine weitere API-Instanz darf einen vorbereiteten Vorgang nicht durch eine neue
Operation überschreiben. Benachrichtigungen dienen nur zur UI-Aktualisierung.
Geschützte Zugriffe gleichen die Generation mit dem Recovery-Kopf in der
Masterdatenbank ab. So öffnet eine separat zurückgespielte alte
Mandantensicherung keinen Schreibweg unter bereits abgelösten Schlüsseln.

## Schlüssel nach einer Recovery wechseln

Nur den Recovery-Katalog für neue Wörter zu verpacken wäre unzureichend. Die alte
Phrase könnte bereits eine Kopie der bisherigen Bereichsschlüssel erschlossen
haben. Deshalb werden alle betroffenen Bereichsschlüssel unabhängig neu erzeugt.
Neue Datenversionen erhalten neue Datenschlüssel und werden ausschließlich unter
der neuen Generation verpackt. Neue Geheimnisse dürfen weder unter alten
Bereichsschlüsseln noch für alte Recovery-Schlüssel veröffentlicht werden.

Die bisherige Signaturautorität bleibt nur zur Prüfung historischer Vorgänge
erhalten. Sie darf keine neuen Identitäten, Freigaben oder Geräte zulassen. Der
neue Administrator bestätigt die weiter geltenden Benutzeridentitäten und
Rechte unter der neuen Autorität. Alte Administratorrechte werden dabei nicht
ungeprüft übernommen. Benutzerkonten können mit ihren bisherigen Passwörtern
erhalten bleiben; ihre Schlüsselpakete werden erst nach erneuter Bestätigung
veröffentlicht. Kompromittierte Identitäten müssen ersetzt werden.

Eine benötigte Änderung an der Mandantendatenbank und die Fortschrittsmeldung an
die Masterdatenbank erfolgen wiederholbar mit Recovery-ID und Generation. Der
Status wird erst wieder freigegeben, wenn der gesamte aktuelle Bereichskatalog
umgestellt ist und der neue Recovery-Katalog alle benötigten Schlüssel enthält.
War der Mandant zuvor noch in Einrichtung, bleibt er in diesem Zustand. Die neue
Regelversion gibt zunächst ausschließlich dem neuen Administrator Zugriff;
weitere Benutzer werden danach erneut bestätigt. Bis zur Übernahme des Plans
bleibt die Sperre für geschützte Zugriffe bestehen.

Vorhandene verschlüsselte Inhalte müssen für den Schutz zukünftiger Änderungen
nicht alle sofort neu verschlüsselt werden. Sie bleiben mit ihren historischen
Datenschlüsseln lesbar und werden für Berechtigte neu verpackt. Ein zusätzliches
Neuverschlüsseln des aktuellen Bestands kann Teil einer Bereinigung sein, löscht
aber keine früher kopierte Version.

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

Der normale Passwortreset eines Mitarbeiters durch einen berechtigten
Mandantenadministrator ist ein anderer Vorgang. Er braucht keine mandantenweite
Seed-Phrase und setzt keine anderen Benutzer zurück.

## Grenzen der Ungültigkeit und Wiederherstellung alter Sicherungen

„Ungültig nach Gebrauch“ bedeutet, dass die aktuelle Infrastruktur keinen
weiteren Recovery-Vorgang mit dieser Phrase akzeptiert. Nach der
Schlüsselumstellung öffnet sie außerdem keine erst danach entstandenen Inhalte.
Alte Datenkopien bleiben jedoch mit den damals gültigen Schlüsseln
entschlüsselbar. Eine Seed-Phrase kann einen einmal geöffneten Datenbestand
nicht nachträglich unlesbar machen.

Die Phrase ersetzt keine Datensicherung. Erforderlich bleiben die verschlüsselten
Daten, ihre technischen Metadaten und ein passender verschlüsselter
Recovery-Katalog. Nach einem Phrase-Wechsel kann eine alte Sicherung unter
Umständen nur zusammen mit dem neueren Recovery-Katalog geöffnet werden. Dieser
enthält deshalb die noch benötigten historischen Bereichsschlüssel und wird
zusammen mit dem aktuellen Recovery-Kopf unabhängig gesichert.

Eine Wiederherstellung der Mandantendatenbank darf den Recovery-Kopf in der
Masterdatenbank nicht zurücksetzen. Beim Rückspielen werden Generation und
Status zuerst abgeglichen. Auch ein vollständiger Betriebsrestore muss den
höchsten bereits bestätigten Recovery-Stand aus einer unabhängig aufbewahrten
Sicherung oder Bestätigung übernehmen. Wenn sämtliche Sicherheitszustände auf
einen alten Stand zurückgesetzt werden und kein neuerer Vertrauensanker
verbleibt, lässt sich die einmalige Nutzung nicht mehr zuverlässig erkennen.

Bei der unabhängigen Aufbewahrung gehören die neue Phrase und der verschlüsselte
aktuelle Recovery-Katalog zum Wiederherstellungspaket. Weitere Geschäftsdaten
bleiben Bestandteil der regulären Sicherung. Der Recovery-Katalog wird nach
Änderungen an Bereichen oder Schlüsselgenerationen ebenfalls gesichert; seine
vertraulichen Inhalte bleiben unter dem aktuellen Recovery-Schlüssel geschützt.

## Nachweise vor produktiver Nutzung

- Zwei API-Instanzen versuchen gleichzeitig dieselbe Phrase zu verwenden. Genau
  eine Operation startet; die andere darf weder einen zweiten Administrator
  erzeugen noch die neue Phrase überschreiben.
- Ein Stromausfall wird vor und nach jedem verbindlichen Schritt simuliert.
  Vor dem ersten Commit funktioniert die alte Phrase, danach die neue Phrase
  zur Fortsetzung. Die Daten bleiben wiederherstellbar.
- Neue kryptografische Bereiche entstehen gleichzeitig mit einer Recovery.
  Kein erfolgreich veröffentlichter Bereich fehlt im wiederherstellbaren Stand.
- Ein Angreifer kennt die alte Phrase und den alten Katalog. Nach Abschluss
  öffnen diese keine neuen Inhalte und erlauben keine neuen Freigaben.
- Eine ältere Tenant-Sicherung wird eingespielt. Die verbrauchte Phrase wird
  dadurch nicht erneut für die aktuelle Recovery gültig; die neue Phrase und
  der passende Recovery-Katalog erschließen die historischen Daten.
- Netzwerk-, Datenbank- und Protokollaufzeichnungen enthalten weder Wörter noch
  private Recovery-Schlüssel. Ein normaler Supportzugang reicht nicht zur
  Wiederherstellung aus.
- Ein Provider-Administrator ersetzt Recovery-Schlüssel in der Datenbank oder
  versucht einen Reset über E-Mail, MFA, Betreiber-JWT oder die normale
  Mandantenautorität. Kein Versuch erzeugt einen akzeptierten Wechsel oder
  erschließt Daten. Ohne gültige Phrase bleibt die Notfallwiederherstellung
  unmöglich.
