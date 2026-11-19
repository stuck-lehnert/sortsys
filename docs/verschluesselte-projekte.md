# Projektgrunddaten und Ansprechpartner

Die verschlüsselten Projektadapter bedienen die bisherigen Aufrufe für
Projektlisten, Einzelansichten, Bearbeitung, Abschließen und Wiederaufnehmen.
Titel, Baustellenadresse, Kunde, Projektverantwortlicher und Auftragseingang
bleiben dabei im Browser. Projektkontakte behalten ihre projektspezifischen
Bezeichnungen, etwa „Bauleitung“ oder „Koordination“.

Jedes Projekt besitzt einen eigenen Bereich für seine Grunddaten. Die Freigabe
eines Projekts öffnet keine anderen Projekte. Eine zusätzliche Freigabe für
Kunden oder Ansprechpartner ist zum Lesen der Projektgrunddaten nicht nötig.
Beim Anzeigen der zugeordneten Kontaktdaten wird dagegen deren eigener
Schlüsselbereich benötigt. Vorgangspreise, Aufmaß und interne Kalkulation haben
unabhängige Schlüssel. Weitere Fachbereiche werden noch umgestellt.

## Freigaben

Nach Auswahl eines bestätigten Benutzerkontos unter **Verwaltung → Organisation
→ Datenschutz** erscheint der Abschnitt **Projektzugriff**. Dort lässt sich ein
Projekt suchen und den Zugriff auf **Projektgrunddaten**, **Projektdateien**,
**Auftragswerte** und **Beschaffung und Weitervergaben** unabhängig auf Lesen
oder Bearbeiten setzen. Eigene Freigaben gelten für Lieferscheine und deren
Preise, Bautagesberichte und deren interne Arbeitskosten sowie Regieberichte und
deren Arbeitszeiten. **Rechnungswerte**, **Werkzeugnutzung im Projekt** und
**Werkzeugkosten im Projekt** sind ebenfalls getrennt freigegeben. Die
[Kostenauswertung](verschluesselte-projektkosten.md) zeigt fehlende Freigaben
an. Der Vergabebereich enthält die belegten Positionen; Angebotspreise des
Nachunternehmers bleiben im eigenen Vorgangsbereich. Die
[Lieferscheinansicht](verschluesselte-lieferscheine.md) trennt gelieferte Mengen
von Sonderpostenpreisen im eigenen Lieferscheinpreisbereich. Die
[Dateifreigabe](verschluesselte-projektdateien.md) öffnet keine anderen
Projektinhalte. Das Entfernen einer Freigabe wechselt den Bereichsschlüssel.
Frühere Leser erhalten den neuen Schlüssel nicht. Bereits kopierte Inhalte
lassen sich dadurch nicht zurückholen.

Bei einer erneuten Freigabe werden die benötigten früheren Schlüsselgenerationen
bereitgestellt. Andere Projekte und Inhaltsbereiche behalten ihre bisherigen
Regeln. Auch eine Administrationsrolle allein ersetzt keine signierte
Lesefreigabe für die Entschlüsselung eines Projekts.

**Neue Projekte anlegen** erlaubt einem bestätigten Mitarbeiter, eigene neue
Projektbereiche zu erstellen. Jedes neue Projekt wird für den Mitarbeiter und
den Administrator freigegeben, der die Anlageberechtigung erteilt hat. Der
Browser stellt außerdem das verschlüsselte Schlüsselpaket für die
Seed-Phrase-Wiederherstellung bereit. Der private Mandantenschlüssel wird dabei
nicht an den Mitarbeiter weitergegeben.

Auch ein angenommenes Haupt- oder Nebenangebot kann ein Projekt anlegen. Dessen
Grunddaten, Angebotszuordnung und erster Auftragswert werden zusammen
gespeichert. Die
[Vorgangsabläufe](verschluesselte-vorgaenge.md#abgabe-annahme-und-weitervergabe)
beschreiben die Annahme und die weitere Arbeit mit Nachträgen und
Weitervergaben.

Das Entziehen dieser Anlageberechtigung verhindert weitere Projekte. Bestehende
Projektfreigaben bleiben erhalten und lassen sich einzeln ändern. Eine
ausdrückliche Einschränkung auf Lesen oder ein vollständiger Entzug gilt auch
für den ursprünglichen Ersteller.

Die API prüft bei der Anlage Empfänger, Signaturen und die gültige
Anlageberechtigung. Ob ein absichtlich veränderter Client tatsächlich denselben
brauchbaren Schlüssel an alle Empfänger verschlüsselt hat, lässt sich daraus
nicht beweisen. Hier gilt dieselbe
[Grenze wie bei ungültigen verschlüsselten Fachdaten](verschluesselung-datenpruefung.md).

Bei der Anlage werden alle vorgesehenen Projekt- und Berichtsbereiche aus einem
gemeinsamen Verzeichnis erstellt. Ihre Schlüssel sind voneinander unabhängig.
Ein zertifizierter Berichtsbereich enthält außerdem den signierten Nachweis
seines ursprünglichen Projekts. Browser und API prüfen Projektkennung,
Erstelleridentität und Wiederherstellungsgeneration. Die API verlangt zusätzlich
den bereits registrierten, identischen Projektanlagenachweis. Ein Mitarbeiter
kann somit keine Berichtsbereiche an ein fremdes Projekt anhängen, indem er
lediglich eine passende Kennung angibt.

Die Bereichsfreigaben bestimmen auch die bereits umgestellten Menüs und
Schaltflächen. Die [Menübeschreibung](menues-und-datenfreigaben.md) nennt die
verbleibenden Anschlüsse.

## Speichern und gleichzeitige Änderungen

Der Browser prüft Projektfelder und Zuordnungen gegen das erzeugte Datenschema.
Ein neuer Kunde oder Ansprechpartner wird im berechtigten Browser erneut
gelesen. Der dabei geprüfte Bestand wird zusammen mit dem Projektstand an die
Speichertransaktion gebunden. Eine zwischenzeitliche Änderung weist die
Speicherung ab, auch wenn die beteiligten Browser verschiedene API-Instanzen
verwenden. Die API prüft dafür Berechtigungen, Signaturen und technische
Versionsstände; sie entschlüsselt keine Projektwerte.

Ein Projektverantwortlicher muss für eine neue Zuordnung derzeit bereits eine
bestätigte Kontoidentität besitzen. Vorhandene Verweise auf Benutzer werden beim
Lesen eines Projekts erhalten, ohne dessen Personaldaten zu laden.
Projektkontakte lassen sich vollständig entfernen, ohne den gesamten
Kontaktbestand zu entschlüsseln.

Eine Speicherung gilt erst als bestätigt, wenn der Browser das verschlüsselte
Objekt erneut gelesen und seine Signatur mit dem gesendeten Stand verglichen
hat. Weitere geöffnete Ansichten erhalten
[Änderungshinweise](verschluesselte-synchronisierung.md) und laden ihre
berechtigten Projektstände nach.

## Noch ausstehende Teile

Nach einer Mandantenwiederherstellung müssen Anlageberechtigungen erneut erteilt
werden. Die Wiederherstellung überträgt bislang alle Projekte an das neue
Administratorkonto; der Erhalt bestehender Mitarbeiterfreigaben über diesen
Wechsel ist noch offen. Die Projektanlage erstellt deshalb bereits alle
bekannten Berichtsbereiche. Soll ein bislang fehlender Bereich nach einer
Wiederherstellung ergänzt werden, benötigt dieser Schritt den lokal entsperrten
Administratorschlüssel; eine neu erteilte Projektanlageberechtigung genügt
nicht.

Die technische Bereichsliste ist derzeit auf 2.000 Bereiche je Mandant begrenzt.
Bei der delegierten Anlage prüft die API diese Grenze vor der Veröffentlichung
neuer Schlüssel. Für größere Bestände benötigen Verwaltung, Änderungsabgleich
und Wiederherstellung noch eine Verarbeitung in mehreren Abschnitten.

Die Suche umfasst Titel und Adresswerte. Der vollständige Vergleich mit der
bisherigen PostgreSQL-Textsuche und deren Sortierung steht noch aus. Die
Sortierung nach Aktivität berücksichtigt bislang Erstellungs- und
Bearbeitungsstand der Grunddaten; Aktivitäten aus Berichten, Dateien oder
anderen geschützten Bereichen werden erst mit deren Adaptern und der
bereichsübergreifenden Auswertung einbezogen.

## Projekt löschen

Die Freigaben Lesen und Löschen reichen, um das Projekt zu entfernen. Der
signierte Löschdatensatz sperrt zugleich die Projektbereiche für Anhänge,
Berichte, Einsatzplanung und weitere abhängige Daten. Geöffnete Ansichten
verlieren den Zugriff auch dann, wenn sie über eine andere API-Instanz
verbunden sind. Eigene kaufmännische Vorgänge mit separaten Schlüsseln behalten
ihren Stand.

Eine Werkzeugbuchung bleibt im Werkzeugbestand erhalten. Wer die Buchung
bearbeiten und den signierten Projektabschluss lesen darf, kann das Werkzeug
auch nach der Löschung zurückgeben oder einem offenen Projekt zuordnen.
Die abgeschlossene Projektansicht ändert sich dabei nicht.

Frühere Fassungen und Dateien bleiben verschlüsselt gespeichert. Eine
Sicherung aus der Zeit vor der Löschung enthält weiterhin den damaligen
Projektstand. Bei einer Wiederherstellung per Seed-Phrase werden auch die
Schlüssel für diese Sicherungen auf das wiederhergestellte Konto übertragen.
Im laufenden Bestand bleibt das Projekt gesperrt. Bereits lokal gespeicherte
Kopien können nachträglich nicht zurückgerufen werden.

Ein früheres PostgreSQL-Archiv ist eine optionale Quelle für die
[Einrichtung eines neuen Mandanten](bestandsumstellung.md).

Die Integrationsprüfungen vergleichen
[Projektfelder und Arbeitsabläufe](../sortsys-webapp-v2/scripts/test-live-projects.ts)
mit dem übernommenen Bestand und prüfen die
[Trennung einzelner Projekte und Inhaltsbereiche](../sortsys-webapp-v2/scripts/test-live-project-permissions.ts).
Die
[Prüfung der Auftrags- und Vergabefreigaben](../sortsys-webapp-v2/scripts/test-live-project-commercial-permissions.ts)
verwendet außerdem ein gewöhnliches Benutzerkonto mit Leseschlüsseln. Die API
weist dessen korrekt signierte Schreibanfragen zurück. Nach einem Entzug öffnen
zurückbehaltene Schlüssel neue Stände nicht; eine erneute Freigabe stellt auch
den Zugriff auf frühere verschlüsselte Stände wieder her. Der Browsertest der
Verwaltungsmaske prüft, dass sich diese Freigaben unabhängig voneinander ändern
lassen.
