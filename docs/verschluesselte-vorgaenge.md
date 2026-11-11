# Angebote und Aufträge im verschlüsselten Speicher

Ein neues Hauptangebot entsteht vor dem Projekt. Seine Bezeichnung, der Kunde und der
Bearbeitungsstand liegen deshalb in einem eigenen Bereich. Eine spätere
Projektzuordnung ändert die Leserechte auf Preise oder interne Notizen nicht.

Die Angebotsübersicht und der Zugriff auf Vorgangsdaten verwenden den neuen
Browseradapter. Er kann Vorgänge lokal suchen, neue Entwürfe anlegen und deren
Grunddaten ändern. Mit vollständiger Inhaltsfreigabe lassen sich GAEB-Dateien
öffnen, anlegen und als Entwurf bearbeiten. Die Statuswechsel und die Übernahme
eines angenommenen Angebots als Projekt sind angeschlossen. Bestandsaufträge
lassen sich ebenfalls übernehmen. Abrechnung und weitere Anschlüsse fehlen noch;
der Entwurf ist weiterhin nicht für den vollständigen Produktivbetrieb freigegeben.

Kopf- und Fachdaten verwenden den [gemeinsamen Datenkern](clientseitige-datenlaufzeit.md).
Der Vorgangsadapter hält dafür keine eigene Datenbank oder Schreibwarteschlange.
Seine Befehle prüfen die Geschäftsabläufe und übergeben die Änderungen samt den
gelesenen Ausgangsversionen an den Kern. GAEB-Dateien bleiben über den gesonderten
Dokumentspeicher angebunden, damit Dateiversion und zugehörige Vorgangsdaten
gemeinsam veröffentlicht werden können.

## Getrennte Inhalte innerhalb eines Vorgangs

| Inhalt | Schlüsselbereich |
| --- | --- |
| Bezeichnung, Kunde, Projektzuordnung, Status, Dokumentbezeichnungen und Verlauf | Grunddaten (`master-data`) |
| Ausgewählte Positionen eines Leistungspakets | Leistungsumfang (`scope`) |
| Gliederung, Positionstexte und Dokumentstruktur | Leistungsumfang (`scope`) |
| Vertragsmengen | Vertragsmengen (`contract-quantities`) |
| Aufmaßzeilen und Berechnungen | Aufmaß (`measurement`) |
| Angebotsbeträge | Angebotspreise (`offer-prices`) |
| Interne Notizen und Beträge interner Kalkulationen | Kalkulation (`calculation`) |
| Beträge bei Weitervergabe und Materialbeschaffung | Beschaffung (`procurement`) |
| Rechnungsbeträge, Steuerangaben, Zahlungsfristen und Zahlungen | Abrechnung (`billing`) |
| Verweise auf ursprüngliche Dokumentdateien | Anlagen (`attachment`) |

Der Browser zerlegt das XML, ohne es neu zu serialisieren. Mengen und Preise
erhalten eigene Teile. Unbekannte Elemente, Attribute und Herstellererweiterungen
werden ebenfalls unverändert aufbewahrt. Da sich deren Inhalt nicht zuverlässig
einem Berechtigungsbereich zuordnen lässt, werden sie nacheinander mit allen
neun Vorgangsschlüsseln verschlüsselt. Eine Freigabe allein für Mengen öffnet
deshalb keinen unbekannten Preis in einem zusätzlichen XML-Attribut.

Mit allen benötigten Schlüsseln setzt der Browser die ursprüngliche Datei
bytegenau zusammen. Für Teilfreigaben liefert die Zerlegung zwar eine
unvollständige Ansicht ohne fremde Inhalte; der bestehende Editor erhält diese
noch nicht. Dafür fehlen ihm ausgeblendete beziehungsweise gesperrte Felder.
Ein Öffnen mit solchen Teilfreigaben endet deshalb derzeit mit einer Meldung.
Es werden keine fehlenden Preise als Nullwerte eingesetzt.

Ohne Preisfreigabe liefert der Adapter keinen Betrag. Ohne Kalkulationsfreigabe
bleiben interne Notizen verborgen. Die Bezeichnung lässt sich trotzdem ändern,
wenn dafür Schreibrechte bestehen. Ein Speichern dieser Änderung überschreibt
die ungelesenen Preise und Notizen nicht mit leeren Werten.

Die API erhält verschlüsselte Pakete und technische Versionsangaben. Sie prüft
Signaturen, Bereichsrechte und gleichzeitig gelesene Versionsstände. Den Inhalt
prüft der Browser: erlaubte Felder, Datentypen, Beziehungen innerhalb des
Vorgangs und die aus dem Datenbankschema übernommenen Bedingungen. Jedes Paket
nennt den zugrunde liegenden Schemastand. Zusätzliche Felder oder ein Preis im
Grunddatenpaket werden beim Lesen zurückgewiesen. Für GAEB-Dateien veröffentlicht
der Browser einen signierten Dokumentstand mit Verweisen auf unveränderliche,
verschlüsselte Teile. Die API prüft Schreibrechte und Schlüsselgenerationen nur
für geänderte Teile. Dokumentstand und geänderte Vorgangsdaten werden gemeinsam
festgeschrieben; eine alte Dokumentversion kann keine neuere überschreiben.
Die prinzipbedingten Grenzen
dieser Prüfung beschreibt die [Datenprüfung](verschluesselung-datenpruefung.md).

Die Angebotsliste und abonnierte Vorgangsdaten erhalten Änderungshinweise über
den WebSocket. Der Browser lädt betroffene Stände nach und verwendet bereits
geprüfte Inhalte weiter, wenn deren technischer Versionsstand gleich geblieben
ist. Geladene Folgeseiten der Liste bleiben ebenfalls abonniert. Bei einem
Konto- oder Zugriffswechsel blendet die Ansicht die bisherigen Werte sofort aus;
eine verspätete Antwort darf sie nicht wieder anzeigen.

## Dokumente im Vorgang bearbeiten

Aus einer Angebotsaufforderung kann der Browser ein Angebot anlegen und dabei
die verwendete Quellversion festhalten. Ändert sich diese Quelle vor dem
Speichern, wird der gesamte Vorgang abgewiesen. Das gilt auch dann, wenn beide
Benutzer mit unterschiedlichen API-Instanzen verbunden sind. Angebot und
Quellbezug werden gemeinsam mit den verschlüsselten Vorgangsdaten gespeichert.

Erneut eingelesene Originale ersetzen den aktuellen Stand derselben Datei.
Die bisherigen signierten Versionen bleiben erhalten. Ein empfangenes,
schreibgeschütztes Original lässt sich dadurch als neue schreibgeschützte
Revision einlesen, aber nicht in einen bearbeitbaren Entwurf umwandeln. Eine
abschließend gesperrte Auftragsbestätigung erlaubt keine weitere Revision.
Beide Regeln prüft die API anhand des signierten Dokumentstands, ohne den
Inhalt zu entschlüsseln.

Der Adapter unterstützt Angebotsaufforderung, Angebot, Nebenangebot,
Auftragserteilung und Auftragsbestätigung sowie Aufmaß und Kalkulation. Bei der
Beschaffung sind Preisanfrage, Lieferantenangebot, Bestellung und
Lieferantenbestätigung angebunden. Welche Datei angelegt werden darf, prüft der
Client am vorhandenen Bearbeitungsstand. Statuswechsel und ihre benötigten
Dokumente prüft er vor dem gemeinsamen Speichern.

Neue und geänderte bearbeitbare Dateien prüft der Browser gegen die offiziellen
GAEB-Schemata, bevor er verschlüsselte Inhalte ablegt. Bei empfangenen Originalen
bleibt das Lesen tolerant. Ein Download setzt die Datei lokal zusammen; die API
erhält weder XML noch Dateiname. Eine reine Umbenennung oder Änderung des
gespeicherten Gesamtbetrags schreibt unveränderte XML-Teile nicht erneut.

## Abgabe, Annahme und Weitervergabe

Ein Hauptangebot benötigt vor der Abgabe einen Kunden und einen geprüften
Nettobetrag. Wurde die Angebotsaufforderung überarbeitet, muss die Kalkulation
deren neue Version verwenden. Die Abgabe hält die verwendeten Dokumentversionen
in einem verschlüsselten Nachweis fest. Eine spätere Überarbeitung löscht diese
Dateistände nicht. Der technische Zugriff auf frühere signierte Versionen ist
angeschlossen; eine eigene Ansicht dafür fehlt noch.

Aus einem angenommenen Hauptangebot kann ein neues Projekt entstehen. Titel,
Kunde, Kundenadresse und Annahmedatum bilden dessen Grunddaten. Projekt,
Angebotszuordnung und Auftragswert werden gemeinsam gespeichert. Wird die
Bestätigung der Speicherung unterbrochen, kann derselbe Vorgang erneut geöffnet
werden, ohne ein zweites Projekt anzulegen. Bei einem angenommenen Nebenangebot
wird auch das ursprüngliche Hauptangebot diesem Projekt zugeordnet.

Ein angenommener Nachtrag ergänzt den Auftragswert des vorhandenen Projekts.
Diese Buchung und die Annahme bilden ebenfalls einen gemeinsamen Schreibvorgang.
Ein zwischenzeitlich abgeschlossenes Projekt weist ihn zurück. Auftragswerte
verwenden einen eigenen Projektschlüssel; die Freigabe der Projektgrunddaten
öffnet sie nicht.

Bei einer Weitervergabe wird das bepreiste Angebot des Nachunternehmers
ausgewählt. Die Beauftragung muss auf dessen aktuelle Dokumentversion verweisen.
Ein eigener verschlüsselter Vergabestand enthält die bereits beauftragten
Positionen je ursprünglichem Auftrag oder Nachtrag. Der normale Adapter liest
diesen Stand und speichert seine Ergänzung gemeinsam mit der Beauftragung.
Konkurrierende Beauftragungen über unterschiedliche API-Instanzen können dadurch
dieselbe Position nicht doppelt belegen. Die API prüft die gemeinsamen
Versionsstände; Positionszugehörigkeit und Beträge prüft der Client.

Aufmaße lassen sich einreichen, zur Überarbeitung zurücknehmen und freigeben.
Kalkulationen können freigegeben werden. Bei der Materialbeschaffung sind Anfrage,
Bestellung und Bestätigung mit den zugehörigen Lieferantendokumenten verbunden.
Ein Statuswechsel schreibt die XML-Dateien nicht neu.

## Einen vorhandenen Auftrag als Grundlage verwenden

In einem bestehenden Projekt kann **Bestandsauftrag übernehmen** eine X84, X85,
X86 oder X87 als Vertragsgrundlage ablegen. D84–D87 und P84–P87 werden vorher
vollständig im Browser in das moderne XML-Format umgewandelt. Die ursprünglichen
Bytes bleiben in der Datei erhalten. Die echten Übernahmemasken sind mit allen
zwölf Formatvarianten geprüft.

Die gelieferte Phase bleibt erhalten: Eine übernommene X84 wird nicht als
Auftragserteilung ausgegeben. Bei X85, X86 und X87 ergänzt der Browser eine X84
als Preisstand. Enthält eine X84 nur Preise, lässt sich das zugehörige
Leistungsverzeichnis ergänzen. Fehlende Mengen werden nicht aus Gesamtsummen
abgeleitet. Die abgelegten Dateien sind schreibgeschützte Originale beziehungsweise
Preisstände; der Vorgang gilt als angenommener Bestandsauftrag.

Dokumentstände, Projektzuordnung und der Verweis auf den Hauptauftrag werden
zusammen gespeichert. Dieser Verweis liegt im verschlüsselten Bereich für
Auftragswerte. Zwei Browser können dadurch auch dann nicht gleichzeitig zwei
Hauptaufträge übernehmen, wenn sie die anderen Vorgänge des Projekts nicht
vollständig lesen können. Vorhandene Angebotssummen bleiben erhalten; nur ohne
vorhandene Angebotsbuchung wird der übernommene Betrag ergänzt.

Die Verarbeitung benötigt keine Klartextdateiablage und keinen XML-Prüfdienst
auf der API. Der Browser prüft auch die abgeleiteten Dateien gegen die offiziellen
GAEB-Schemata. Das Projekt wird beim abschließenden Speichern nochmals über seinen
Versionsstand geprüft, damit ein gleichzeitiger Projektabschluss die gesamte
Übernahme zurückweist.

## Bestehende Vorgänge übernehmen

Die Bestandsvorbereitung überträgt Vorgangsdaten, Dokumentmetadaten,
Verlaufseinträge, Rechnungsdaten und Zahlungseingänge aus dem bereits geprüften
Browserbestand. Ein erneuter Durchlauf vergleicht vorhandene Pakete mit der
Quelle. Er überschreibt abweichende Pakete nicht.

Die Beträge der Vorgänge bleiben Dezimalwerte; ihre Verarbeitung verwendet keine
Gleitkommasummen. Auch die Mikrosekunden bestehender Zeitstempel bleiben
erhalten. Der aktuelle XML-Inhalt wird anschließend im Browser aufgeteilt und
verschlüsselt. Ein unterbrochener Durchlauf setzt bei den bereits signierten
Dokumentständen fort. Historische Dateistände bleiben vorerst im gesicherten
Quellbestand. Diese Teilübernahme aktiviert den Mandanten nicht
und löscht keine ursprünglichen PostgreSQL- oder S3-Daten.

Vorhandene Auftragswerte der Projekte und bereits beauftragte Leistungspakete werden
in die beiden getrennten Projektbereiche übernommen. Bestehende Finanzzeilen
behalten dabei ihre ursprünglichen Gleitkommawerte. Neue Auftragsbuchungen
halten den genauen Dezimalbetrag zusätzlich fest. Rechnungsbuchungen gehören
zur noch ausstehenden Abrechnungsumstellung.

## Noch fehlende Anschlüsse

Die [Positionssuche](verschluesselte-positionssuche.md) ist mit dem geschützten
Browserpfad verbunden. Die bisherigen XML-Sockets und
lokalen Klartextentwürfe werden im privaten Dokumentpfad nicht verwendet.
Änderungshinweise laufen über den verschlüsselten Datenkanal der Anwendung;
Cursoranzeige und gleichzeitiges Schreiben innerhalb desselben Textfelds sind
damit noch nicht umgesetzt. Bisherige Klartext-Endpunkte werden dafür nicht als
Ersatz aufgerufen.

Neue Rechnungen bleiben gesperrt, bis ein gemeinsam aktualisierbares,
verschlüsseltes Abrechnungsregister die bisherigen Prüfungen über mehrere
Rechnungen ermöglicht. Rechnungsnummern, Zahlungen und Stornierungen brauchen
anschließend ihre eigenen Schreibabläufe. Bereits übernommene Rechnungsdaten
lassen sich mit Abrechnungsfreigabe lesen.

Verlaufseinträge enthalten derzeit noch keinen aufgelösten Mitarbeiternamen.
Bei neuen Vorgängen verwendet die Referenz vorläufig die Vorgangs-ID hinter
Kürzel und Jahr; bestehende Referenzen bleiben erhalten. Die technische
Bereichsliste ist außerdem noch auf 2.000 Bereiche je Mandant begrenzt. Neun
Bereiche pro Vorgang machen deren paginierte Verarbeitung vor einer allgemeinen
Freigabe notwendig. Pro Vorgang werden außerdem höchstens 10.000 Datenzeilen
geprüft. Längere Verläufe brauchen eine getrennte, paginierte Verarbeitung.

Der Integrationstest liegt in
[`test-live-commercial.ts`](../sortsys-webapp-v2/scripts/test-live-commercial.ts).
Er verwendet den Musterbestand und zwei API-Prozesse. Der ergänzende
Dokumenttest in [`test-live-gaeb.ts`](../sortsys-webapp-v2/scripts/test-live-gaeb.ts)
prüft die XML-Übernahme und den normalen Öffnen-/Speichern-Pfad.
[`test-live-gaeb-workflows.ts`](../sortsys-webapp-v2/scripts/test-live-gaeb-workflows.ts)
ergänzt neue Dokumente, Revisionen, Quellkonflikte, Downloads und die endgültige
Sperre einer Auftragsbestätigung. Die
[Ablaufprüfung](../sortsys-webapp-v2/scripts/test-live-commercial-workflows.ts)
prüft Statuswechsel, Dokumentnachweise, konkurrierende Projektübernahmen und
Weitervergaben sowie die gemeinsame Speicherung von Annahme und Auftragswert.
Die [Bestandsauftragsprüfung](../sortsys-webapp-v2/scripts/test-live-commercial-adoption.ts)
prüft Originalphasen, Legacy-Dateien, bestehende Buchungen, Zeitstempel mit
Mikrosekunden und konkurrierende Übernahmen über unterschiedliche API-Instanzen.
Die [Positionsprüfung](../sortsys-webapp-v2/scripts/test-live-positions.ts)
vergleicht Vorschläge aus Vorgängen und Projektdateien, Revisionen und Löschungen.
Sie weist außerdem einen Aufruf des bisherigen Klartextindex oder das Öffnen
eines Preis- beziehungsweise Mengenschlüssels während der Suche zurück.
Die [Mitarbeiterprüfung](../sortsys-webapp-v2/scripts/test-live-position-permissions.ts)
ergänzt neue Lesefreigaben auf vorhandene Dokumente, Händlerpositionen,
Rechteentzug und erneute Freigabe. Der fokussierte Wiederherstellungslauf prüft
den Positionsbestand anschließend auch nach zwei Wechseln der Seed-Phrase.
Der
[Berechtigungstest](../sortsys-webapp-v2/scripts/test-live-commercial-access.ts)
prüft einen gewöhnlichen Mitarbeiter, dem Preis- und Notizschlüssel entzogen
werden, während die Vorgangsbezeichnung bearbeitbar bleibt.
