# Funktionsstand der verschlüsselten Anwendung

Dieser Abgleich beschreibt den Stand vom 18. November 2026. Die API speichert
verschlüsselte Geschäftsdaten und prüft öffentliche Zugriffsnachweise. Suche,
Berechnungen und fachliche Inhaltsprüfungen laufen im Browser. Es gibt weder
eine Trusted Execution Environment noch eine vorübergehende Entschlüsselung
durch die API. Die [Architektur](verschluesselung-und-berechtigungen.md) und die
[Grenzen der Datenprüfung](verschluesselung-datenpruefung.md) erläutern diese
Entscheidung.

Ein implementierter Adapter belegt noch keinen vollständig geprüften
Arbeitsablauf. Die folgenden Abschnitte unterscheiden deshalb zwischen
vorhandenen Funktionen, nativen Mehrinstanztests und noch offenen Prüfungen.
Vergleichbare Suchergebnisse oder eine bestimmte Geschwindigkeit werden nicht
allein aus der Wahl von DuckDB abgeleitet.

Ein früherer Produktionsbuild hat alle 18 Browserabläufe mit zwei API-Instanzen
in einem Rust-Testprozess bestanden. Für die aktuelle Fassung baut der Test den
Musterbestand mit zwei getrennten API-Prozessen und einem gemeinsamen
DuckDB-Dienst auf. Der frische Aufbau prüft beide Beispielkonten und 50
Geschäftsvorgänge sowie den Erhalt manueller Änderungen nach einem Neustart
des Seedings.

Der Browserlauf mit einer Kopie dieses Bestands hat Anmeldung, GAEB-Autosave
und gemeinsame Bearbeitung, Projektanhänge, Dokumentensuche und gesperrte
Direktlinks geprüft. Ein Zeitüberschritt beim Neuladen einer Werkzeugansicht
beendete den Lauf. Ein vollständiger Durchlauf aller Browserabläufe steht für
die aktuelle Fassung aus.

## Zugang und Freigaben

**Anmeldung und eigener Passwortwechsel.** Die Passwortanmeldung richtet das
persönliche Konto automatisch mit demselben Passwort ein; spätere Änderungen
verschlüsseln dessen Zugang im Browser neu. PRF-fähige Passkeys öffnen den
bestehenden Kontospeicher auch auf einem neuen Gerät direkt im Browser. Ohne PRF
benötigt ein neues Gerät das gewöhnliche Passwort; ein bereits geschützter
Gerätespeicher bleibt verwendbar.

Ein nativer Chromium-Test verwendet die echten Passkey-Endpunkte zweier
API-Instanzen und einen virtuellen Authenticator. Er prüft das Öffnen nach dem
Leeren des lokalen Schlüsselspeichers, Passwortwechsel und Umbenennung über den
Personalworkflow. Unsignierte oder veränderte Einrichtungen, fremde Herkünfte,
mandantenübergreifende Credential-Kopien und wiederholte Antworten werden
abgewiesen. Gleichzeitige Antworten mit Zählerstand null erzeugen genau eine
Sitzung. Löschung und Seed-Recovery sperren auch frisch signierte Anmeldungen.
Der Browsermodus der nativen API-Tests führt diesen Ablauf mit aus; Screenshot
und Protokolle bleiben als Testartefakte erhalten. Die Framework-Prüfungen
decken außerdem fehlerhafte CBOR-Pakete, Kurvenpunkte und Authenticator-Flags ab.

**Benutzer anlegen und deren Passwort zurücksetzen.** Die Benutzeranlage
speichert persönliche Profile verschlüsselt und legt nur technische
Kontometadaten an der API an. Nach einer Einladung registriert das neue Mitglied
sein Passwort im Browser über OPAQUE. Identitäten werden vor der
Bereichsfreigabe bestätigt. Ein vorhandener Passkey ermöglicht den anschließenden eigenen Passwortwechsel. Fehlt jeder
lokale Zugang, kann die aktuelle Seed-Phrase bei der mandantenweiten Recovery
zusätzlich ein Mitarbeiterkonto wiederherstellen. Benutzerkennung,
Personalprofil und historische Signaturen bleiben erhalten. Das Konto bekommt
neue private Schlüssel und zunächst keine Fachdatenfreigaben; nach erneuter
Einladung sind auch seine bisherigen Inhalte wieder lesbar. Der isolierte
Admin-Reset ohne Phrase bleibt gesperrt; der Anbieter erhält keinen
Wiederherstellungszugang. Siehe [Benutzerzugang](benutzerfreigaben.md).

Ein bestätigter Signaturschlüsselwechsel ist im Kontoprotokoll angeschlossen.
Er benötigt beide Benutzerschlüssel und die Zustimmung der Mandantenautorität;
Passwortverlust deckt er dadurch noch nicht ab. Ein nativer Mehrinstanztest
prüft unvollständige und gefälschte Nachweise, verlorene und falsche Antworten,
das Schreiben nach der Erneuerung und die Ablehnung des alten Signaturschlüssels.
Historische Zertifikate und Inhalte bleiben auch nach einer Seed-Recovery
prüfbar. Ein Dialog für diesen Ablauf fehlt noch.

**Administrationszugang nach Passwortverlust.** Die aktuelle Seed-Phrase kann
das primäre Administratorkonto unter derselben Benutzerkennung
wiederherstellen. Passwort, private Schlüssel und Phrase wechseln; frühere
Signaturen bleiben prüfbar. Ein Mehrinstanztest prüft zwei Wiederherstellungen
desselben Kontos, den Erhalt verschlüsselter Inhalte und die Ablehnung alter
Passwörter und Phrasen. Vorbereitete Pläne scheitern auch nach einem parallelen
Passwort- oder Namenswechsel. Gelöschte und gesperrte Konten werden nicht
reaktiviert; die Oberfläche bietet ausdrücklich ein neues Konto als Alternative
an. Optional lässt sich in derselben Transaktion ein gewöhnliches Mitglied
wiederherstellen. Ein eigener Mehrinstanztest prüft dessen unveränderte
Benutzerkennung, fehlende Administratorrechte, den Erhalt seines persönlichen
Assistentenverlaufs nach erneuter Freigabe und konkurrierende Passwortwechsel.

**Fein abgestufte Lese- und Schreibrechte.** Getrennte Schlüssel schützen
Teilinhalte; signierte Regeln begrenzen technische Schreibaktionen. Die
gemeinsame Rechteauswahl für Stammdaten, Projekte, Personal und Werkzeuge erlaubt
Lesen, Anlegen, Bearbeiten und Löschen einzeln. Einzelne Änderungen erhalten andere
aktuelle Rechte; mehrere Bereiche werden gemeinsam signiert. Fachliche
Bedingungen über Geheimwerte prüft der Client. Die unabhängige Löschung von
Unterzeilen benötigt teils noch feiner aufgeteilte Objekte.

Das Framework und die API unterstützen außerdem bereichsgebundene
Verwaltungsrechte mit dem eigenen Signaturschlüssel des beauftragten Nutzers.
Die Hauptadministration gibt diesen Nutzern keinen privaten Mandantenschlüssel.
Ein nativer Test mit vier Konten und zwei API-Instanzen prüft Lese- und
Schreibfreigaben, historische Schlüsselkopien, Schlüsselwechsel, unzulässige
Empfänger und Inhaltsbereiche sowie konkurrierende Änderungen. Ein bereits
signierter Schreibauftrag wird nach dem Rechteentzug abgewiesen. Nach dem
Widerruf der Verwaltungsbefugnis bleiben unabhängig vergebene Mitarbeiterrechte
erhalten; weitere Schlüsselveröffentlichungen des Verwalters werden abgewiesen.
Die gemeinsame Rechtefunktion und eine eigene Freigabenansicht verwenden diese
delegierte Verteilung. Die Hauptadministration vergibt das Verwaltungsrecht in
der bisherigen Rechteauswahl. Anlagenachweise gewähren Bearbeitungsrechte für
das neue Objekt, aber keine Freigabenverwaltung. Diese Befugnis wird gesondert
von der Hauptadministration vergeben.

Der native Browsertest prüft die fertige Webapp mit drei getrennten Sitzungen
gegen zwei API-Instanzen. Eine Katalogfreigabe macht die Produkte beim Empfänger
sichtbar; ihr Entzug entfernt die Inhalte und den Menüeintrag wieder. Auch das
Entziehen und erneute Vergeben des Verwaltungsrechts wird in der Oberfläche
geprüft. Unzulässige Verwaltungsaktionen bleiben ausgeblendet. Der vorhandene
Browsermodus der API-Tests führt diesen Ablauf mit aus und sichert Screenshots
und Ablaufprotokolle als CI-Artefakte.

Historische Schlüsselkopien und neue Schlüsselgenerationen werden gemeinsam in
begrenzten Stapeln veröffentlicht. Die Nachprüfung liest nur die bearbeiteten
Bereiche. Im echten Zwei-Nutzer-Browsertest mit dem Musterbestand werden zwei
Werkzeugbereiche in einer Transaktion freigegeben; auch der spätere Rechteentzug
und die erneute Vergabe bleiben innerhalb der normalen Wartezeit von 20 Sekunden.
Das belegt keine feste Antwortzeit für größere Mandanten oder lange
Schlüsselhistorien. Überschreitet eine Änderung die Stapelgrenze, besteht sie aus
mehreren einzeln atomaren Transaktionen.

**Menüs und Aktionsschaltflächen.** Die bereits verschlüsselten Stammdaten und
Projektaktionen verwenden verifizierte Inhaltsfreigaben. Angebots- und
Projektanlage bleiben getrennt; zertifizierte Anlagenachweise werden
berücksichtigt. Konto- und Rechtewechsel verwerfen alte Menüstände. Weitere
Fachbereiche und einzelne Editoraktionen benötigen noch Anschlüsse. Siehe
[Menüs und Datenfreigaben](menues-und-datenfreigaben.md).

**Personalprofile und interne Stundensätze.** Bestandsübernahme, Anlage, Listen,
lokale Suche und Profiländerungen verwenden getrennte Bereiche je Person für
Namen, Personalangaben und Stundensätze. Formulare verbergen nicht freigegebene
Werte und überschreiben sie beim Speichern nicht. Werkzeugauswahl und
Namensanzeigen sind angeschlossen. Die Organisationsverwaltung kann die drei
Bereiche einzeln freigeben. Aktivierung, Deaktivierung und Archivierung
verbinden Profil, Kontostatus und signierte Zugriffssperre atomar. Umbenennen
speichert Namensindex und Profil gemeinsam. Löschen entfernt alle drei
Profilbereiche und sperrt das Konto dauerhaft; historische Signaturen bleiben
prüfbar. Ein nativer Mehrinstanztest prüft auch manipulierte und unvollständige
Befehle, konkurrierende Änderungen, verlorene Antworten, einen gültig signierten
Wiederanlegeversuch und die Kontosperre nach Seed-Recovery. Direkte und
Standardvorgesetztenzuordnungen müssen vor der Löschung geändert werden.
Browsertests prüfen Sichtbarkeit und Bestätigungsdialog. Rollenänderungen fehlen
noch. Abwesenheiten haben einen eigenen Adapter;
Vorgesetzten- und Vertragswechsel verbinden die Personaländerung mit ihren
automatisch abgeleiteten Freigaben. Der native Fachadapterlauf prüft
Profiländerungen und zwei Recoveries über getrennte API-Instanzen. Vollständige
Textsuchparität steht aus. Siehe
[Personaldaten](verschluesselte-personaldaten.md).

**Abwesenheiten und Urlaub.** Bestandsübernahme, eigene Anträge, Entscheidungen,
Rücknahmen und Jahreskontingente sind angeschlossen. Antrag und Entscheidung
werden getrennt verschlüsselt; die Entscheidung gilt nur für die exakte
Antragssignatur. Formulare behalten Datum, Vorgangskennung und angezeigte
Version bei. Einladungen erhalten eigene Antragsrechte. Entscheidungen können in
den Personalfreigaben einzeln erlaubt werden. Eigene Antragsrechte, automatische
Genehmigung für externe Kräfte oder Personen ohne Vorgesetzten und
Entscheidungen entlang aller Vorgesetztenebenen sind angeschlossen.
Vorgesetztenwechsel erhalten manuelle Ausnahmen und sichern Personal und Rechte
gemeinsam ab. Der native Fachadapterlauf prüft Bestandsübernahme, Anträge,
konkurrierende Entscheidungen, Rücknahmen und Zeitnachweise über zwei getrennte
API-Instanzen. Zwei Recoveries erhalten die Daten; die vollständige Prüfung aller
automatischen Vorgesetztenfreigaben steht noch aus. Siehe
[Abwesenheiten](abwesenheiten-protokoll.md).

## Angebote, Projekte und Baustellenabläufe

**GAEB bearbeiten, D-/P-Dateien lesen, X-Dateien speichern.** Projektdateien und
Vorgangsdokumente verwenden verschlüsselte Speicher. Mengen, Preise und Texte
haben getrennte Schlüssel; unbekannte Inhalte bleiben verlustfrei erhalten. Der
Vorgangsdialog öffnet Teilansichten und erlaubt Textänderungen ohne
Preisschlüssel. Preisänderungen sind mit lesbaren Mengen und unterstützten
Berechnungsregeln möglich, auch ohne vertrauliche Erweiterungen. Eine X84 kann
ihre Mengen aus einer separat freigegebenen X83 beziehen. Statuswechsel,
angenommene Angebote als neue Projekte und Bestandsaufträge aus X84–X87 samt
D-/P-Varianten sind angeschlossen. Die
[Abrechnung](verschluesselte-abrechnung.md) unterstützt Entwürfe, Festschreibung
und Zahlungen; Bestandsübernahme und getrennte Mitarbeiterfreigaben sind über
zwei API-Instanzen geprüft. Ein Browserdurchlauf mit Mitarbeiterkonto prüft
Ausstellung, Zahlungen und Rechteentzug einschließlich der anschließenden
Lesefreigabe. Siehe
[Vorgangsadapter](verschluesselte-vorgaenge.md). Vollständige XML-Dateien prüft
der Client gegen das XSD; Teilansichten erhalten eine begrenzte Struktur- und
Änderungsprüfung. Die API kann gültig signierte Geschäftsinhalte nicht fachlich
zurückweisen.

**Automatisches Speichern und gemeinsame Bearbeitung.** Stammdaten, Vorgänge,
Dateien und KI-Verläufe erhalten technische Änderungshinweise über mehrere
API-Instanzen. GAEB-Dateien lesen gespeicherte Stände verschlüsselt nach. Der
[Nachrichtenweg](verschluesselte-gaeb-zusammenarbeit.md) überträgt
Textänderungen und Präsenz verschlüsselt; Yjs führt Texte im Browser zusammen.
Browserzustände, Nachrichtenabrufe und Speicherbestätigungen folgen getrennten
Inhaltsbereichen. Signierte Bestätigungen binden deren Stand atomar an das
gespeicherte Dokument. Endgültige Sperren entfernen alte Live-Überlagerungen;
noch offene lokale Texte bleiben als Entwurf verfügbar. Text- und
Preisänderungen mit Teilfreigaben sind angeschlossen. Der Druck prüft die
dargestellten Inhalte und benötigt keine verborgenen internen Notizen. Zwei
Browser mit demselben Konto sind gegen getrennte API-Instanzen geprüft,
einschließlich Textabgleich vor der XML-Veröffentlichung und erneutem Öffnen
nach dem Speichern. Mit John und Frank ist auch die gemeinsame Änderung des
Feldes „Bauvorhaben“ ohne Preisfreigabe über zwei API-Instanzen geprüft, ebenso
Rechteentzug und erneute Nur-Lesen-Freigabe. Ein eigener Browserfall prüft zwei
gleichzeitig bearbeitete Absätze einer X83-Position. Dauerhafte
Wiederanlaufpunkte und das spätere Zusammenführen heruntergeladener Teilentwürfe
brauchen weitere Arbeit.

**Projektgrunddaten und Projektkontakte.** Getrennte Bereiche je Projekt,
Grunddaten, Kontaktbezeichnungen und Statuswechsel sind angeschlossen.
Projektfreigaben öffnen keine Kalkulationsschlüssel. Mitarbeiter können mit
begrenzter Freigabe neue Projekte anlegen; Pflichtempfänger und Recovery werden
dabei berücksichtigt. Auftragswerte, die Belegung bei Weitervergaben und die
einzelnen Berichtsarten haben unabhängige Projektbereiche. Weitere abhängige
Fachbereiche sowie vollständige Such- und Aktivitätsparität fehlen noch. Siehe
[Projektadapter](verschluesselte-projekte.md).

**Bautagesberichte und Arbeitszeiten.** Bestandsübernahme, Listen, Datumsfilter,
Anlage, Bearbeitung, Löschung und Fotobezüge verwenden den verschlüsselten
Datenkern. Berichte samt Stunden und interne Kosten haben getrennte
Projektfreigaben; beide sind von Regiestunden unabhängig. Formulare behalten
Zeilenkennungen und Versionen bei. Kryptografische Modell- und Browsertests
liegen vor. Der native Kostenvergleich übernimmt vorhandene Berichte und erhält
ihre Kosten nach zwei Recoveries. Der
[native Fachablauf](../sortsys-webapp-v2/scripts/test-native-business-workflows.ts)
prüft außerdem Anlage, Stundenänderung, historische Stundensätze, veraltete
Formulare und verlorene oder falsche Speicherantworten über zwei API-Instanzen.
Fotos und die Recovery dieser neu bearbeiteten Berichte stehen noch aus. Für
persönliche Abwesenheiten und die Einsatzplanung bestehen eigene Adapter. Die
Projektkostenübersicht verwendet die erfassten Stunden und Stundensätze.

**Regieberichte.** Bestandsübernahme, Liste, Datumsfilter, Bearbeitung und
Materialkosten verwenden verschlüsselte Projektbereiche und die lokale
Datenlaufzeit. Stunden sind vom Material getrennt freigegeben. Eigene
Schlüsselbereiche trennen Regieberichte von Lieferscheinen und Tagesberichten.
Formulare erhalten Zeilenkennungen und Kommentare; gesperrte Teile werden
ausgelassen. PDF und Excel kennzeichnen nicht freigegebene Stunden. Der native
Fachablauf prüft Anlage und Stundenänderung über zwei API-Instanzen, stabile
Zeilenkennungen, unveränderte Sonderposten, Versionskonflikte und eine verlorene
Speicherantwort. Der Vergleich übernommener Berichte mit den früheren
API-Ergebnissen und ihre anschließende Recovery sind weiterhin nicht
nachgewiesen.

**Werkzeuge, Buchungen und Inventuren.** Eigene verschlüsselte Bereiche je
Werkzeug und Buchung; Kosten sind getrennt. Bestandsübernahme, lokale Suche,
Filter, Stammdatenänderungen, Ausgabe, Rückgabe, Inventuren und Umbuchungen sind
an den gemeinsamen Datenkern angeschlossen. Historische Kosten bleiben erhalten;
Ausgaben und Umbuchungen werden für die gesamte Auswahl atomar veröffentlicht.
Die beim Auswählen bekannte aktive Buchung wird beim Speichern mitgeprüft.
Verschlüsselte Bestätigungen verhindern doppelte Ausgaben beim Wiederholen
nach einer verlorenen Antwort. Der native Mehrinstanztest prüft konkurrierende
Buchungen, Ablehnungen und die Wiederholung nach einer Rückgabe. Die
Personalauswahl verwendet verschlüsselte Profile. Freigaben für Werkzeuge und
einzelne Buchungen lassen sich beim Benutzerkonto getrennt nach Stammdaten,
Kosten, Inventuren und Umbuchungsanfragen verwalten.
Die Aktionen der Detailansicht prüfen das jeweilige Werkzeug und seine Buchung.
Neue Buchungen gewähren dem zugewiesenen, kryptografisch registrierten Mitarbeiter
automatisch Leserechte ohne Kostenfreigabe. Rückgabe und Umbuchung beenden dieses
abgeleitete Recht. Ein nativer Test mit zwei API-Instanzen prüft die Freigabe,
abgewiesene Schreibversuche, den Entzug und den administrativen Schlüsselwechsel.
Ein weiterer nativer Ablauf prüft diese Buchungen über zwei Recoveries hinweg:
historische Inhalte und Kosten bleiben erhalten, alte Schlüssel öffnen keine
späteren Änderungen. Alte Mitarbeiterzertifikate bleiben gesperrt. Nach einer
erneut bestätigten Einladung erhält der Verantwortliche Leserechte für seine
aktive Buchung, während abgeschlossene Buchungen und Kosten verborgen bleiben.
Der aktuelle Administrator bestätigt dafür den bestehenden Buchungsbereich
mit einem an die genaue Ausgangsrevision gebundenen Nachweis. Eine veraltete
Bestätigung veröffentlicht nichts; eine verlorene Antwort und deren
Wiederholung verändern keinen bereits bestätigten Aktivitätsnachweis.
Die Bestätigung einer späteren Einladung führt Leserechte für vorher angelegte,
noch aktive Buchungen nach. Ein administrativer Werkzeugabruf gleicht außerdem
Buchungen bereits registrierter Mitarbeiter ab. Ein nativer Test prüft den
fehlenden ursprünglichen Aktivitätsnachweis, die spätere Freigabe, verborgene
Kosten, einen gültig signierten abgewiesenen Schreibversuch und den Entzug nach
Rückgabe. Für Rückgabe und Umbuchung durch den Verantwortlichen fehlen noch Anschlüsse. Ohne
Administrationsrecht bleibt der Schlüsselwechsel nach einer Rückgabe vorgemerkt.
Die Ausgabe ohne lesbare Kosten und vollständige Textsuchparität stehen ebenfalls
aus. Siehe
[Werkzeugverwaltung](verschluesselte-werkzeuge.md).

**Einsatzplanung und Baustellensperren.** Bestandsübernahme, Listen, Anlage,
Änderungen, Löschen und atomare Projektwechsel verwenden einen eigenen
Schlüsselbereich je Projekt und die gemeinsame Datenlaufzeit. Die Oberfläche
erhält aktualisierte Listen über verschlüsselte Ereignisse. Eigene Einsätze
verwenden zusätzliche Schlüsselpakete je Datensatzrevision; dafür wird kein
Bereichsschlüssel verteilt. Ein weiterer nativer Test prüft zwei Benutzerkonten,
die Einladungsfreigabe bestehender Einsätze, verweigerte Fremdzugriffe,
ausdrückliche Lesesperren und den Signaturschlüsselwechsel. Änderungen über die
erste API erreichen die Eigenansicht am WebSocket der zweiten. Die beiden
Instanzen dieses Tests laufen in einem Rust-Prozess. Zwei Recoveries erhalten
Einsätze und Benutzerkennungen; alte Zugänge, Phrasen und Schlüssel werden
abgewiesen. Nach erneuter Einladung ist die Eigenansicht wieder lesbar. Der
zugehörige Browsertest prüft die fertige Webapp nach der zweiten Recovery mit
zwei getrennten Sitzungen: eigene und verborgene fremde Einsätze, fehlende
Planungsaktionen, automatische Aktualisierung, Löschung und Neuladen. Ohne
Projektstammdaten verwendet die Eigenansicht eine verschlüsselte Kopie der
Projektbezeichnung, die reine Umbenennungen noch nicht nachführt. Persönliche
Abwesenheiten kommen aus dem eigenen verschlüsselten Adapter. Atomare
Baustellenwechsel, Wiederholungen, veraltete Formulare und verlorene oder
falsche Speicherantworten sind über zwei echte API-Instanzen geprüft. Die
Recovery der Baustellensperren ist dabei noch nicht gesondert geprüft. Siehe
[Einsatzplanung](verschluesselte-einsatzplanung.md).

## Katalog, Kontakte und Kosten

**Produkte einschließlich Beschreibung suchen.** Listen, Suche, Anlegen,
Bearbeiten und Kategorien sind verbunden; Preisaufzeichnungen verwenden einen
eigenen Schlüssel. Produktlöschung entfernt Kategorien und abhängige Preise. Der
Preislistenimport veröffentlicht neue Produkte und Preise gemeinsam über
vorbereitete verschlüsselte Pakete. Weitere Produktverweise in noch nicht
umgestellten Fachbereichen und der vollständige Suchvergleich fehlen noch.

**Lieferanten und Preisaufzeichnungen.** Lieferantensuche über
Namen/Beschreibung, Anlage, Änderungen und Löschung sowie Preisänderungen und
signierte Löschungen sind angeschlossen. Öffentliche signierte Beziehungen
erlauben die Prüfung vorhandener Ziele und das Aufheben einer
Lieferantenzuordnung ohne Preisschlüssel. Freigaben für Lieferanten und Preise
bleiben getrennt. Siehe
[Lieferanten und Preise](verschluesselte-lieferanten-und-preise.md).

**Lieferscheine und Materialkosten.** Bestandsübernahme, Listen, Details,
Anlage, Bearbeitung und Kostenberechnung verwenden getrennte Mengen- und
Beschaffungsschlüssel je Projekt. Historische Preise werden im Browser
einschließlich Mikrosekunden und numerischer Kennungen ausgewählt. Anlagen sind
über mehrere Instanzen nummeriert und wiederholbar; Mengenänderungen erhalten
nicht lesbare Preise. Löschen erfordert ein eigenes Recht im Mengenbereich und
entfernt auch die Preise aus aktuellen Abfragen, ohne deren Schlüssel zu öffnen.
Verschlüsselte historische Fassungen und die vergebenen Nummern bleiben erhalten.
Projektwechsel und eine physische Bereinigung der Historie fehlen noch.
Siehe [Lieferscheine](verschluesselte-lieferscheine.md).

**Kunden und Ansprechpartner.** Getrennte Schlüsselbereiche mit lokaler Suche,
Bearbeitung und Zuordnungen sind angeschlossen. Zusätzliche gelesene Bestände
werden beim Speichern technisch auf Gleichzeitigkeit geprüft. Löschung verwendet
Markierungen; Projektverweise, physische Bereinigung und der vollständige
Suchvergleich fehlen noch. Siehe
[Kunden und Kontakte](verschluesselte-kunden-und-kontakte.md).

**Gemeinkostensätze und Stichtage.** Verschlüsselte Einzelobjekte, eigene
Benutzerfreigaben und atomisches Speichern aller drei Sätze sind angeschlossen.
Bestandsübernahme, Mehrinstanzbetrieb und zwei Seed-Recoveries sind geprüft.
Siehe [Gemeinkosten](verschluesselte-gemeinkosten.md).

**Projektkosten, Deckungsbeiträge und historische Preise.** Detailberichte und
Übersicht rechnen lokal mit historischen Preisen und Gemeinkosten. Fehlende
Freigaben ergeben leere Beträge mit einer Erklärung. Rechnungswerte und
projektbezogene Werkzeugnutzung besitzen eigene Schlüsselbereiche. Übernommene
zugeordnete Rechnungswerte sind unveränderlich und von optionalen OTS-Belegen
unabhängig. Manuelle Finanzänderungen erscheinen im Projektverlauf.
Bestandsübernahme, sechs Vergleiche mit PostgreSQL, abgewiesene signierte
Änderungsversuche über zwei API-Instanzen und zwei Seed-Recoveries sind geprüft.
Neue Rechnungen werden zusammen mit Nummer und XML-Sperre im Projekt gebucht;
der ergänzende Mehrinstanztest prüft auch Zahlungen und Schlussabrechnungen.
Siehe [Projektkosten](verschluesselte-projektkosten.md).

## Abrechnung, Druck und Darstellung

**Rechnungen, Abschläge, Zahlungen und Statusübergänge.** Der Browseradapter
rechnet und prüft X89-Dokumente, vergibt Nummern und legt ausgestellte Werte und
Zahlungen unveränderlich ab. Mehrinstanzbetrieb, verlorene Bestätigungen und
zwei Recoveries sind geprüft. Der Mitarbeitertest prüft getrennte Rechte für
Rechnung, Auftrag, Projektbuchung und Nummernvergabe. Bei der Rücksicherung
behalten ausgestellte Abschläge ihre Nummer und ihre Zahlungen. Die API
garantiert keine fachliche Richtigkeit geheimer Beträge. Siehe
[Abrechnung](verschluesselte-abrechnung.md).

**Rechnungsnummern und technische Eindeutigkeit.** Berechtigte Clients leiten
geheime Belegungskennungen aus den Nummern ab. Die API erzwingt deren
Einmaligkeit und gemeinsame Veröffentlichung mit der Rechnung, ohne die Nummer
zu lesen. Ein bewusst veränderter Client könnte eine falsche Zuordnung
signieren; die fachliche Gleichheit geheimer Nummern bleibt deshalb eine
Clientprüfung.

**Typst-Druck mit Bildern und PDFs.** Vorlagen und Anlagenverzeichnis sind mit
einem eigenen Schlüsselbereich verbunden; Originale verwenden unveränderliche
verschlüsselte Dateiblöcke. Vorschau, Medienprüfung und Kompilierung bleiben im
Browser. Einladungen geben die Vorlage zum Drucken frei. Siehe
[Druckvorlagen](verschluesselte-druckvorlagen.md).

**Unternehmensanschrift und Nummernschema.** Die vorhandenen Formulare lesen und
speichern verschlüsselt. Einladungen geben die Anschrift automatisch zum Lesen
frei; das Rechnungsnummernschema hat einen eigenen Schlüssel. Jede
Formularansicht prüft ihren eigenen Ausgangsstand und bestätigt Änderungen erst
nach erneutem Lesen. Weitere Organisationseinstellungen fehlen noch. Siehe
[Organisation](verschluesselte-organisation.md).

**Persönliche GAEB-Ansichtseinstellungen.** Die Einstellungen werden
verschlüsselt übernommen und automatisch je Konto gespeichert, unabhängig von
KI-Rechten. Andere normale Benutzer erhalten keinen Zugriff. Kontowechsel
verwerfen wartende Schreibvorgänge. Der native Fachadapterlauf prüft Speicherung
und zwei Recoveries über getrennte API-Instanzen. Siehe
[Ansichtseinstellungen](verschluesselte-ansichtseinstellungen.md).

**Oberflächensprache.** Deutsch und Englisch lassen sich je Konto wechseln, ohne
Schreibzugriff auf Personalprofile. Die technische Sprachkennung bleibt an der
API sichtbar. Ab Beginn der Bestandsübernahme wird sie getrennt von der
unveränderten Benutzerquelle gespeichert.
[Details](verschluesselte-ansichtseinstellungen.md#oberflächensprache).

## Dateien und lokale Suche

**Dokumentvolltext mit Sprachen, Ranking und Ausschnitten.** Dateinamen und
vorhandener extrahierter Text sind lokal durchsuchbar. Neue PDFs werden im
Browser ausgelesen. Sprachverarbeitung, Ranking und vergleichbare Ausschnitte
sind inzwischen für deutsche und englische Wortformen, Phrasen, Ausschlüsse und
Wortanfänge angeschlossen. Ein Worker bewertet Treffer und erzeugt sichere
Ausschnitte. Native Mehrinstanztests prüfen den Rechteentzug trotz gefülltem
Cache; Browsertests prüfen den Worker und eine tatsächlich ausgelesene PDF.
Die genaue Übereinstimmung mit PostgreSQL ist weiterhin nicht nachgewiesen.
Ein kaltes Gerät und fehlender OCR-Text schränken Ergebnisse ein. Siehe
[Dokumentensuche](verschluesselte-dokumentensuche.md).

**Positionsdatenbank aus bisherigen GAEB-Dateien.** Die Suche liest freigegebene
Vorgangstexte und Projektdateien im Browser. Mengen und Preise aus Vorgängen
werden dafür nicht geöffnet. Der begrenzte RAM-Index wird aus aktuellen
signierten Quellen aufgebaut; Suchbegriffe bleiben lokal. Siehe
[Positionssuche](verschluesselte-positionssuche.md).

**PDF-, DWG-, MSG- und EML-Vorschau.** Dateiablage, Ordner und Uploads sind
angeschlossen; Originale und Vorschauen werden erst im Browser entschlüsselt.
PDF- und EML-Browsertests prüfen echte Darstellung und Bereinigung bei
Kontowechsel. Siehe [Projektdateien](verschluesselte-projektdateien.md).

**PDF-Text, OCR und Vorschaubilder ohne offenen Browser.** Kein gleichwertiger
Hintergrundbetrieb. Lokale Arbeiten können mit dem Tab enden. Die
LLM-/OCR-Ausnahme gilt nur für den ausdrücklich aufgerufenen Ablauf.

**EuroOffice/ONLYOFFICE.** Normale Dateidialoge verwenden CryptPads
Browsereditoren. Gemeinsame DOCX-Bearbeitung und Lesezugänge sind geprüft;
weitere Dateifunktionen und laufende Änderungen bei Rechteentzug bleiben offen.

**diagrams.net.** Diagramme verwenden denselben geschützten Editorablauf und
dieselbe verschlüsselte Projektablage wie Office-Dateien. Der echte Diensttest
prüft gleichzeitige Änderungen an zwei Formen, erneutes Öffnen mit Leserechten,
nativen XML-Export und die Wiederherstellung eines noch nicht als Projektdatei
bestätigten Entwurfs. Gemeinsame Nachrichten werden verschlüsselt übertragen.
Komponententests prüfen den Rechteentzug und verspätete Antworten beim
Dateiewechsel für DOCX und Drawio. Komplexe Diagramme und eingebettete Bilder
brauchen weitere Prüfungen. Siehe
[Editorprüfungen](editoren-ohne-klartextserver.md).

## Assistent, Verläufe und eigene Werkzeuge

**LLM-Chat, Einlesen und MCP-Katalogsuche.** Chat und Einlesen verwenden
Live-MCP und verschlüsselte Benutzerverläufe. Produktvorschläge werden lokal
geprüft und bei Annahme zusammen mit ihrem Ausführungsnachweis gespeichert.
Die Chatübernahme aus einer alten Sicherung erhält die Benutzerzuordnung.
Historische Annahmen ohne Ergebnisprotokoll bleiben erkennbar und werden nicht
erneut ausgeführt. Frühere Einleseverläufe lassen sich bei der Ersteinrichtung
aus einer zusätzlich ausgewählten Verwaltungsdatensicherung übernehmen. Dabei
werden nur die ausdrücklich gewählte Organisation und bekannte Benutzer
berücksichtigt. Die Originaldatensätze bleiben verschlüsselt erhalten. Neue Anfragen brauchen die
signierten Rechte des persönlichen Assistentenbereichs; Katalogsuche,
Preiszugriff und Schreibwerkzeuge bleiben getrennt. Konten ohne technische
Rollen können mit den passenden Freigaben chatten und Dokumente einlesen. Ein
Mehrinstanztest prüft diese Adapter einschließlich Rechteentzug und erhaltenem
persönlichem Verlauf. Weitere Chat-Werkzeuge und die Übernahme in weitere
Fachabläufe sind noch zu ergänzen. Die Klartextausnahme bleibt auf den
freigegebenen Kontext der laufenden Anfrage begrenzt.

**Laufende LLM-Anfragen beim Seitenwechsel.** Eine gemeinsame Laufzeitverwaltung
hält Anfragen im geöffneten Tab. Beim Einlesen bleibt der nicht schließbare
Dialog bis zum geprüften und verschlüsselt gespeicherten Ergebnis offen. Neue
Anfragen brauchen keine serverseitigen Hintergrundjobs. Übernommene frühere
Einlesevorgänge kennzeichnen wartende oder laufende Anfragen als unterbrochen.

**Listen, zuletzt geändert und zuletzt besucht.** Persönliche Besuche,
Aktionsverläufe und Dashboard-Fixierungen verwenden den verschlüsselten
Datenkern. Gleichzeitig gespeicherte Einträge werden nach Versionskonflikten
erneut zusammengeführt; Fixierungen werden nach bestätigter Übernahme aus dem
alten Klartextspeicher entfernt. Der gemeinsame Änderungsverlauf wertet
angenommene signierte Stände aus und übernimmt vorhandene Einträge mit
ursprünglichen Urhebern und Zeitpunkten. Feldänderungen und historische Namen
folgen getrennten Inhaltsfreigaben. Einträge ohne eindeutige Zuordnung bleiben
vorerst in gesonderten Bereichen der Autorität; deren normale Rechteauswahl und
gemischte freie Beschreibungen fehlen noch. Der native Fachadapterlauf prüft
wiederholte Übernahme und zwei Recoveries über getrennte API-Instanzen. Siehe
[persönliche Verläufe](persoenliche-verlaeufe.md) und
[gemeinsamen Änderungsverlauf](gemeinsamer-aenderungsverlauf.md).

**Eigene Client-Skripte.** Skripttexte, Metadaten und Suche verwenden den
verschlüsselten Browseradapter. Eigene Schlüssel und getrennte Rechte für Lesen,
Anlegen, Bearbeiten und Löschen sind angeschlossen. Die ursprünglichen Skripte
werden mit ihren Urhebern übernommen. Ein nativer Test prüft zwei API-Instanzen,
Rechteentzug und zwei Recoveries. Die Ausführung bleibt auf die Datenfreigaben
des angemeldeten Kontos beschränkt.

## Sicherung und Schemaänderungen

**Sicherung und Wiederherstellung.** Die Betreiberverwaltung erstellt
geschlossene verschlüsselte Mandantendateien und bietet sie zum Download an. Die
unabhängige Kontrolldatei und die Office-Stände gehören zusätzlich zur
vollständigen Sicherung. Alte Recovery- und Rechtezustände werden
zurückgewiesen. Laufende Bereichsfreigaben, Schlüsselzuordnungen und
Anlagenachweise erhalten ebenfalls unabhängige Nachweise. Der veränderliche
Inhaltscursor bleibt davon getrennt. Die Organisationsverwaltung kann einen
älteren Fachstand prüfen und freigeben. Die Vorschau prüft die lesbaren
Projekte und Adressdaten, einschließlich ihrer Verknüpfungen untereinander.
Ein vollständiger Abgleich der verschlüsselten Fachdaten steht noch aus.
Ein Test startet den Datendienst aus einem vollständigen DuckDB-Dateisatz neu
und prüft Anmeldung, ein Projekt, dessen Anhang und einen weiteren
Phrase-Wechsel. Die [Betriebsdokumentation](deployment.md#sicherungen-und-wiederanlauf)
beschreibt die getrennte Office-Ablage und die Aufbewahrung aktueller
Sicherheitsnachweise.

**Migrationen über Inhaltsfelder.** Berechtigte Clients migrieren Inhalte.
Servermigrationen betreffen nur öffentliche Hüllen und Referenzen.

Die Browser lesen Berechtigungsverzeichnisse inzwischen in geprüften Seiten
mit höchstens 128 Bereichen. Die Vertrauenskette und die signierten Regeln
werden nur mit der ersten Seite übertragen. Das behebt die bisherigen
Gesamtgrenzen noch nicht: Registrierung, weitere Verwaltungsabrufe und
Wiederherstellungspläne begrenzen weiterhin den gesamten Bestand auf
2.000 Inhaltsbereiche beziehungsweise 50.000 bisherige Schlüsselhüllen je
Recovery-Plan. Eine gemeinsame, gegen Rücksetzen geschützte Zählung prüft jetzt
auch zusätzliche Schlüsselgenerationen und den Recovery-Commit. Die
Kapazitätsprüfung reserviert Platz für eine weitere vollständige
Schlüsselrotation. Diese Werte begrenzen reale Bestände, nicht nur einzelne
Netzwerkpakete. Der fertige Plan wird inzwischen in hashgeprüften Teilen von
höchstens 128 KiB übertragen und erst vollständig aktiviert. Dieser Transport
ist auf 512 Teile und 64 MiB begrenzt. Er beseitigt die einzelne große
Plananfrage. Ein nativer Lasttest veröffentlicht 96 Bereiche mit je 105
Schlüsselgenerationen über die regulären Endpunkte. Nach einer Seed-Recovery
über eine zweite API-Instanz bleiben die beiden gespeicherten Inhalte aus der
ersten und letzten Generation lesbar. Der Zähler stimmt mit allen 10.080
historischen Generationen und den anschließend neu angelegten Schlüsseln
überein. Das belegt noch keine Such- oder Bediengeschwindigkeit bei großen
Fachbeständen und hebt die Grenze von 2.000 Bereichen nicht auf.

Die Prüfung betrifft die heutigen Browseradapter für
[Produkte](../sortsys-webapp-v2/app/lib/data/products.ts),
[Projektkosten](../sortsys-webapp-v2/app/lib/data/projectCosts.ts) und
[Abrechnung](../sortsys-webapp-v2/app/lib/data/commercialBilling.ts) sowie
[verschlüsselte Dokumentnachrichten](../sortsys-api-v2/rust-api/src/zerotrust/document_messages/persistence.rs),
[Typst](../sortsys-gaeb/src/core/typstCompiler.ts),
[Editorfreigaben](../sortsys-api-v2/rust-api/src/editors.rs) und die
[Skriptlaufzeit](../sortsys-webapp-v2/app/lib/clientScriptRuntime.tsx). Die
früheren SQL-Handler und Klartext-Dokumentrouten sind aus der API entfernt.

## Office-Dokumente ohne Klartext-Dokumentserver

CryptPads
[Office-Anbindung](https://github.com/cryptpad/cryptpad/blob/86dc5ae80daa47f3b46487da9b33aeeb38846899/www/integration/main.js)
nimmt eine Datei als `Blob` im Browser entgegen und meldet gespeicherte Stände
ebenfalls als `Blob` zurück. Die
[Installation der Office-Komponenten](https://github.com/cryptpad/cryptpad/blob/86dc5ae80daa47f3b46487da9b33aeeb38846899/install-office.sh)
bindet auch die WASM-Konvertierung ein. Die normalen sortsys-Dateidialoge
verwenden inzwischen diesen Weg und einen eigenen Dienst für Editorcode und
verschlüsselte Sitzungsstände.

Der neue Browseradapter verwendet ausschließlich den Blob-Weg und prüft bei
`postMessage` das Absenderfenster und die genaue Origin. Er wartet vor dem
Öffnen auf die verschlüsselt gespeicherte Sitzungsfreigabe. Der Dateiadapter
bestätigt Speichervorgänge erst nach der verschlüsselten Ablage. Ein Leser
erhält keinen Bearbeitungszugang. Zwei unabhängige Browseranmeldungen haben in
einem echten Editorlauf gemeinsam ein DOCX geändert; ein dritter Browser konnte
den gemeinsamen Stand mit dem Leseschlüssel öffnen. Nicht als Datei bestätigte
Änderungen vor Rechtewechseln, weitere Dateifunktionen und lokale Editor-Caches
bleiben zu prüfen. Die
[Quellprüfung der Office- und Diagrammeditoren](editoren-ohne-klartextserver.md)
beschreibt die geprüften Wege und bisherigen Tests.

## Volltextsuche konkret erhalten

### Produktkatalog

Die Bestandsumstellung überführt geprüfte Produktzeilen samt Kategorien und
Preisaufzeichnungen jetzt in getrennte verschlüsselte Sammlungen. Ein
Katalogleser braucht den Preisschlüssel weder anzufordern noch zu öffnen.
Umgekehrt kann eine reine Preisfreigabe Preisaufzeichnungen öffnen, ohne den
Schlüssel für Produktbeschreibungen anzufordern. Die
[Browserkomponente](../sortsys-webapp-v2/app/lib/data/products.ts) prüft die
entschlüsselten Zeilen gegen das abgeleitete Fachdatenmodell in DuckDB. Exakte
Kennungen und Zeitstempel mit Mikrosekunden bleiben bei dieser Umwandlung
erhalten.

Die API liefert die verschlüsselten Objekte seitenweise. Jede Seite gehört zu
einem bestätigten Änderungsstand; Änderungen während des Abrufs erzwingen einen
Neustart. Der Leser veröffentlicht erst die vollständig geprüfte Sammlung. Der
Datendienst lädt die Ciphertexte einer Seite gemeinsam und prüft dabei ihre
Inhaltsadressen. Die API begrenzt Anzahl und Datenmenge pro Seite. Im Browser
laufen höchstens 16 Entschlüsselungen gleichzeitig; Zugriffe auf dieselbe
Schlüsselgeneration teilen sich eine bereits laufende Anfrage. Signaturen,
Mandantenbindung und Zeilenstruktur werden weiterhin für jedes Objekt geprüft.
Eine beschädigte Seite oder ein nachträglicher Kontowechsel liefert keinen
teilweise geprüften Katalog. Fehler beim Lesen des privaten JSON enthalten keine
Ausschnitte aus dem entschlüsselten Inhalt. Zusammengehörige Schreibpakete
verwenden eine gemeinsame Transaktion und Versionsprüfung im gemeinsamen
DuckDB-Dienst. Mehrere API-Instanzen vergleichen dabei die gelesenen Datensätze
und Katalogstände mit dem Stand beim Speichern. Geheime Produktinhalte werden
dafür nicht gelesen.

Fehlen die Schlüsselpakete in einer Objektseite, liest der Browser den
Bereichsnachweis und die eigene Schlüsselhülle gemeinsam unter derselben
Berechtigungsprüfung. Bereits mitgelieferte Pakete benötigen keinen weiteren
Abruf. Fehlerhafte oder fehlende Pakete werden abgewiesen; sie lösen keine
zusätzlichen Einzelabrufe aus.

Schreibanfragen nennen außerdem den vollständig geprüften Katalogstand. Zwei
reguläre Clients können dadurch nicht gleichzeitig dieselbe Artikelnummer für
verschiedene Produkte auf Grundlage eines veralteten Stands vergeben. Ein
berechtigter Client kann weiterhin absichtlich fachlich ungültige Inhalte
signieren; diese Grenze der Inhaltsprüfung bleibt bestehen.

Die lokale Suche berücksichtigt Beschreibung, Namen, Marke, Artikelnummer und
Regiebezeichnung. Wortanfänge und die Verknüpfung mehrerer Suchwörter sind
implementiert. PostgreSQLs vollständige Wortzerlegung, insbesondere bei URLs,
Bindestrichen und anderen Satzzeichen, ist damit noch nicht nachgebildet. Die
normale Produktoberfläche verwendet diesen lokalen Zugriff für Listen, Suche,
Anlegen, Bearbeiten, Kategorien und Einheitenvorschläge. Abonnierte Listen
werden nach einer lokalen Änderung aktualisiert. Der
[Ereignisabgleich](verschluesselte-synchronisierung.md) aktualisiert sie auch
bei Änderungen über eine andere API-Instanz. Nach Verbindungsabbrüchen werden
Berechtigungen und Datenstand erneut geprüft.
[Einladungen](benutzerfreigaben.md) stellen bestätigten Konten ausgewählte
Katalog- und Preiszugriffe bereit. Für diese Bereiche ist auch das Ändern
bestehender Freigaben angebunden. Änderungen am Leserkreis sperren neue
Schreibvorgänge bis zum automatischen Schlüsselwechsel. Ein unterbrochener
Wechsel lässt sich bei erneutem Öffnen der Verwaltung fortsetzen.
Preisänderungen und signierte Produkt-/Lieferantenlöschungen sind inzwischen
[angeschlossen](verschluesselte-lieferanten-und-preise.md). Die optionale
[Backupübernahme](bestandsumstellung.md) führt die angeschlossenen Fachadapter
bei der Einrichtung eines neuen Mandanten zusammen. Ein signierter Abschluss
bindet ihre Quellbelege und Zielstände. Die frühere Installation und ihre
Originaldateien bleiben dabei unverändert. Verbleibende Unterschiede sind bei
den jeweiligen Arbeitsabläufen aufgeführt.

Der [Integrationstest](../sortsys-webapp-v2/scripts/test-live-products.ts)
vergleicht Katalog und Beschreibungstreffer mit dem bisherigen Bestand. Er prüft
außerdem einen neuen Leser nach einer Änderung, den Abbruch eines veralteten
Seitenabrufs, den Rollback eines teilweise ausgeführten Schreibpakets,
konkurrierende Schreibanfragen und getrennte Freigaben für Katalog und Preise in
beiden Richtungen. Der
[Rechtetest](../sortsys-webapp-v2/scripts/test-live-permissions.ts) prüft
außerdem den Entzug mit unterbrochenem Schlüsselwechsel, neue Inhalte, die mit
dem alten Schlüssel nicht mehr lesbar sind, sowie die erneute Freigabe mit einer
verlorenen Bestätigung. Bereits bekannte Schlüssel lassen sich nicht
zurückholen; neue Preisstände benötigen nach einem Rechteentzug eine
Schlüsselrotation.

Der gemeinsame Browser-Client führt Fachaufrufe lokal aus und verweigert einen
ungeprüften Netzwerkaufruf. Das gilt auch für dynamische Aufrufe und abonnierte
Listen: Ein serverseitiges Verbot allein würde nicht verhindern, dass
Suchbegriffe oder Formulareingaben bereits im HTTP-Request auftauchen.
API-Antworten bleiben im begrenzten RAM-Cache. Das unabhängige Setup verwendet
keinen bisherigen unverschlüsselten IndexedDB-Cache.

Der [Ablauf laufender LLM-Anfragen](llm-im-browser.md) beschreibt den
Fortschrittsdialog und den flüchtigen MCP-Transport. Der Chat verwendet bereits
den geschützten Produktkatalog; weitere Fachaufrufe und Einlese-Folgeaktionen
sind noch umzustellen. Neue Einleseergebnisse werden bereits im Client geprüft
und in einem eigenen verschlüsselten Benutzerbereich abgelegt. Auch frühere
Einleseverläufe sind angeschlossen: Benutzereigentum, ursprüngliche Zeitpunkte
und verwendbare Ergebnisse bleiben erhalten. Unterbrochene oder fehlerhafte
Ergebnisse erhalten eine entsprechende Meldung; die vollständige Quelle bleibt
im Archiv. Alte Chatverläufe werden mit ihren ursprünglichen
Benutzerzuordnungen, Nachrichten und Entscheidungen übernommen. Fehlende
historische Ausführungsnachweise bleiben als fehlend erkennbar; die Übernahme
führt keine Vorschläge erneut aus. Der native Chat-Test prüft Rechteentzug und
zwei Recoveries samt erneuter Mitgliederfreigabe.

### Weitere Suchen und verbleibende Unterschiede

Die früheren PostgreSQL-Suchen hatten verschiedene Bedeutungen. Stamm- und
Produktdaten verwendeten `create_query` mit der Konfiguration `simple`,
verknüpften Wörtern und Präfixsuche. Die Positionssuche hatte eine eigene
Wortzerlegung und Präfixabfrage. Die Dokumentvolltextsuche verknüpfte deutsche
und englische `websearch_to_tsquery`-Abfragen mit einer einfachen Wortabfrage.
Sie erzeugte Ausschnitte über `ts_headline` und sortierte nach `ts_rank_cd`
sowie stabilen weiteren Kriterien. Kaufmännische Listen verwendeten dagegen auch
`ILIKE` über Bezeichnung, Referenz und Kundenname.

Ein Austausch gegen ein beliebiges JavaScript-`includes` oder die ungeprüfte
Standardsuche einer anderen Datenbank wäre daher keine Funktionsgleichheit. Auch
eine korrekte Suche in nur einem bereits geladenen Ausschnitt darf nicht als
Suche über alle berechtigten Daten dargestellt werden.

Die Browser-Datenbank ist DuckDB-Wasm. Die Dateisuche verwendet einen eigenen
Worker mit deutscher und englischer Wortstammverarbeitung. Verknüpfte Wörter,
Präfixe, Phrasen, Ausschlüsse und `OR` haben Vergleichstests. Dateinamentreffer,
Häufigkeit und Wortabstände bestimmen die Relevanz; Ausschnitte verwenden
Zeichenbereiche für die Hervorhebung. Stoppwörter, URLs, zusammengesetzte Wörter
und die genaue Reihenfolge von `ts_rank_cd` benötigen weitere Vergleichsfälle.
Die übrigen Fachsuchen behalten ihre jeweils eigene Suchbedeutung. Die
[Dokumentensuche](verschluesselte-dokumentensuche.md) beschreibt den umgesetzten
Umfang; eine vollständige Funktionsgleichheit wird daraus nicht abgeleitet.

Der aktuelle Client baut seine Suchdatenbank im Arbeitsspeicher aus den
freigegebenen verschlüsselten Datensätzen auf. Die entschlüsselte DuckDB-Datei
wird weder in IndexedDB noch in OPFS abgelegt. Das vermeidet eine weitere
ungeschützte Datenkopie, kostet auf einem neuen Gerät aber Übertragungszeit und
Arbeitsspeicher. Ein Index, der nur einen geladenen Ausschnitt durchsucht, darf
nicht als vollständige Suche über alle berechtigten Daten erscheinen.

Zusätzliche verschlüsselte Suchsegmente könnten den ersten Abruf großer
Dokumentbestände verkürzen. Ein solcher persistenter Suchindex ist noch keine
zugesagte Funktion. Er müsste Quellversionen und Inhaltsfreigaben binden, damit
beispielsweise vertrauliche Preisnotizen nicht als allgemein lesbare Ausschnitte
erscheinen. Dateinamen, Trefferzahlen und Gleichheitsmerkmale gehören ebenfalls
zu diesem Schutz.

### Quack für die serverseitige Ablage

Der Dienst `duckdb` ist in beiden Compose-Dateien und in der
Entwicklungsumgebung enthalten. Er verwendet DuckDB 2.0 mit
[Quack](https://duckdb.org/docs/2.0/quack/overview). Nur dieser Dienst öffnet
die Dateien zum Schreiben. API-Instanzen verbinden sich über das interne
Netzwerk; Browser erhalten weder eine Quack-Verbindung noch das Dienstkennwort.

Jeder Mandant erhält `tenants/<technische-kennung>.duckdb`. Der Dateiname wird
aus der Mandantenkennung abgeleitet und enthält keine Firmenbezeichnung. Eine
separate `control.duckdb` gehört dem Datendienst. Chiffrate und ihre technischen
Verweise liegen gemeinsam in der Mandantendatei. Ein Paket wird zuerst dauerhaft
gespeichert, bevor der API-Vorgang seinen Verweis veröffentlicht. Bei einem
abgebrochenen Vorgang können unerreichbare verschlüsselte Pakete zurückbleiben;
ein teilweise veröffentlichter Fachstand wird dadurch vermieden.

Das neue Setup läuft unabhängig von der bisherigen Installation. Es gibt keinen
vorgesehenen Mischbetrieb und keine laufende Bestandsmigration. Ein altes
PostgreSQL-Backup wird ausschließlich im Browser bei der Einrichtung eines neuen
Mandanten gelesen; die [Bestandsübernahme](bestandsumstellung.md) beschreibt
diesen Weg und seine Grenzen.

Der Produktionsstart verwendet den eigenständigen DuckDB-Datendienst. Anmeldung,
Ersteinrichtung, Schlüsselregister, Objekt- und Dokumentstände,
Kataloglöschungen, Live-LLM-Sitzungen und die OpenTimestamps-Warteschlange
laufen über diesen Speicher. Der optionale Backupweg verwendet eine lokale
SQL-Quelle, keine laufende alte Datenbank. Der Datendienst verweigert inzwischen
eine Mandantendatei mit älteren Recovery- oder Sicherheitsnachweisen. Im
[Wiederanlauftest](mandanten-wiederherstellung.md#nachweise-vor-produktiver-nutzung)
bleibt ein zweiter Mandant in diesem Fall erreichbar. Die vollständige
Prüfung aller Fachabläufe nach einem Wiederanlauf steht noch aus.

Die [Betreiberverwaltung](verschluesselte-sicherungen.md) erstellt mit
`COPY FROM DATABASE` eine eigene DuckDB-Datei und schließt sie vor der
Veröffentlichung. Erst nach dem Synchronisieren und atomaren Umbenennen lässt
sich diese Datei herunterladen. Sie kann unabhängig vom laufenden Dienst
geöffnet werden. Ein beliebiges Kopieren der aktiven Datei wäre unsicher:
Bestätigte Änderungen können noch im
[Write-ahead-Log](https://duckdb.org/docs/2.0/operations_manual/footprint_of_duckdb/files_created_by_duckdb)
liegen, und während des Kopierens könnten weitere Änderungen eintreffen. Der
aktuelle Recovery-Stand muss auch nach der Wiederherstellung einer älteren
Sicherung verhindern, dass eine bereits verbrauchte Phrase wieder gültig wird.

Quack stellt eine [SQL-Oberfläche](https://duckdb.org/docs/2.0/quack/security)
bereit. Der Dienst ist deshalb ausschließlich über das interne Datennetz
zugänglich und verlangt ein Dienstkennwort. Die API prüft weiterhin
Mandantenzugehörigkeit und Berechtigungen. In DuckDB werden die unveränderlichen
verschlüsselten Pakete über ihren Hash adressiert; ihre Klartexte oder
Entschlüsselungsschlüssel werden dort nicht benötigt.

Die Rust-Anbindung nutzt direkte C-API-Abfragen: Vorbereitete Anweisungen der
Rust-Bibliothek funktionieren derzeit nicht durchgängig mit `CONNECT`.
Konkurrierende Schreibtransaktionen verwenden Versionsprüfungen im gemeinsamen
Datendienst. Technische Metadaten und Objektverweise werden gemeinsam bestätigt.
Das Änderungsjournal enthält ausschließlich technische Kennungen und Hinweise,
keine entschlüsselten Fachinhalte. Die neue Übertragung wartet pro aktivem
Mandanten und API-Instanz auf Commits und verteilt die Hinweise an dessen
Browser. Sie übernimmt keine Rechteentscheidung des Clients: Die API prüft den
jeweils aktuellen Zugriff, bevor sie Hinweise auf einen geschützten Bereich
weitergibt.

Konfiguration und der Umfang der Netzwerkprüfungen stehen in der
[Anleitung zum Datendienst](../sortsys-store/README.md).

Sofortige vollständige Ergebnisse auf einem neuen Gerät werden nicht zugesagt.
Es gibt keinen privaten Suchdienst mit einer bereits vollständigen Indexkopie.
Die Oberfläche muss den Synchronisierungsstand erkennbar machen und
unvollständige Ergebnisse entsprechend kennzeichnen.

Ein Bereich mit Preisen darf keine Suchbegriffe oder Ausschnitte in einen weiter
lesbaren Leistungsindex einschleusen. Dasselbe gilt für Dateinamen,
Trefferzahlen und einen öffentlichen SHA-256-Fingerabdruck bekannter
Positionstexte. Die frühere Installation und ihre Klartextindizes gehören nicht
zum neuen Laufzeitbetrieb. Blindindizes sind keine vorausgesetzte Abkürzung: Sie
verändern Suchmöglichkeiten und offenbaren Gleichheiten beziehungsweise
Suchmuster.

Die lokale Suchkomponente führt Textabgleich, Rechteprüfung und Pagination aus.
Die Auswahloberfläche filtert ihre Ergebnisse nicht nochmals nach dem
Anzeigenamen.

## Vergleichsfälle und Freigabekriterien

Vergleichstests verwenden dieselben erlaubten Quellstände aus dem früheren
PostgreSQL-System und dem lokalen Suchweg. Verglichen werden Treffer,
Reihenfolge, Ausschnitte, Pagination und erkennbare Unvollständigkeit des
Indexstands. Nötig sind unter anderem:

- Ein Produkt wird ausschließlich über ein Wort in seiner Beschreibung gefunden;
  Namen und Artikelnummer enthalten das Wort nicht.
- Mehrere Suchwörter, Präfixe und Artikelnummern mit Satzzeichen behalten die
  bisherige Bedeutung. Umlaute, `ß`, Bindestriche, unterschiedliche
  Schreibweisen und sehr kurze Suchwörter werden gezielt verglichen.
- Deutsche und englische Dokumenttexte, zitierte Wortfolgen und Ausschlüsse
  liefern dieselben zulässigen Treffer. Abweichende Wortstämme oder Ausschnitte
  werden nicht als bloß kosmetische Unterschiede abgetan.
- Ein Benutzer mit Teilrechten findet keine Treffer oder Ausschnitte aus
  verborgenen Preisen, Nachunterlagen oder fremden Projekten. Das gilt auch,
  wenn eine Suchanfrage Wörter aus mehreren Inhaltsbereichen kombiniert.
- Ein neues Gerät, ein gelöschter Browsercache und unterbrochene
  Synchronisierung erzeugen keine irreführend vollständige leere Ergebnisliste.
- Ein neuer PDF-Upload erhält Text und OCR-Ergebnisse einschließlich
  Aktualisierung des Index. Fehler, Wiederholungen und veraltete Ergebnisse nach
  einem Dateiwechsel werden korrekt behandelt.

Für Kosten und Rechnungen werden dieselben Eingaben einschließlich
Dezimalstellen, historischer Preise, Nachlässe, Steuer, Rundung und
Abschlagsketten verglichen. Gleichzeitige Änderungen benötigen aktuelle
Versionen und gültige Schreibrechte. Ungültige Felder, falsch typisierte Werte
und manipulierte CRDT-Pakete gehören zu den Negativfällen: Der berechtigte
Client darf sie nicht ungeprüft anwenden. Die API kann ihre fachliche
Ungültigkeit nicht erkennen.

Neben dem Ergebnis zählt der Arbeitsablauf: neue Anmeldung, erster Suchzugriff,
warmer Suchzugriff, schneller Text, gleichzeitige Bearbeitung und unterbrochene
Synchronisierung werden auf schwächeren Geräten gemessen. Die zusätzlichen
Kosten für Arbeitsspeicher, Indexspeicher und Datentransfer werden mit erfasst.
Für diese Gerätevergleiche liegen noch keine belastbaren Leistungswerte vor.

## Noch nicht gleichwertig zugesagte Funktionen

Der reine Browseransatz hat weiterhin keine vollständige serverseitige
Inhaltsprüfung und keine unabhängig von Endgeräten verfügbare Suche oder OCR.
Diese Einschränkungen werden für den ersten Ausbau bewusst akzeptiert. Es gibt
keinen stillschweigenden Ersatz durch einen Dienst mit
Entschlüsselungsschlüsseln.

Der neue Office-Weg verwendet CryptPads Browsereditoren. Seine bereits geprüften
Datei- und Zusammenarbeitsfunktionen ersetzen keinen vollständigen Vergleich
aller Office-Funktionen. Der frühere Klartext-Dokumentserver und Jobrunner
gehören nicht zum neuen Laufzeitbetrieb. Die LLM-Ausnahme erlaubt keinen
allgemeinen Hintergrundzugriff auf verschlüsselte Dateien.

Damit ist fachliche Gleichwertigkeit für viele Arbeitsabläufe erreichbar, aber
weder eine unveränderte Gesamtarchitektur noch vollständige Funktions- und
Performancegleichheit nachgewiesen. Ein produktiver Wechsel darf erst für die
jeweils geprüften Bereiche erfolgen.
