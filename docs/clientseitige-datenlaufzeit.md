# Gemeinsamer Datenkern im Browser

Die Datenlaufzeit unter `sortsys-webapp-v2/app/lib/data/runtime` verbindet das
fachliche Datenmodell mit dem verschlüsselten Objektspeicher. Fachmodule
beschreiben ihre Daten und ändern sie in Transaktionen. Sie brauchen dafür keine
eigene Datenbank, Schlüsselverwaltung, Schreibwarteschlange oder Cache-Pflege.

Ein Datenmodell legt das Dateiformat und die Bindung eines Objekts an seinen
Schlüsselbereich fest. Enthält es vollständige `sortsys-row-v2`-Zeilen, findet die
Laufzeit deren Tabellen, Schlüssel und Felder automatisch. Die Typen, Längengrenzen,
Referenzen und SQL-Bedingungen stammen aus
[`sortsys-webapp-v2/schema/business.json`](../sortsys-webapp-v2/schema/business.json).
`node scripts/generate-browser-schema.mjs` erzeugt daraus die Browserkopie samt
Prüfsumme. Dafür wird keine Datenbank gestartet.
Zusätzliche Fachregeln bleiben in der Modellprüfung oder im Fachbefehl.

Die lokale SQL-Prüfung bündelt Zeilen je Bedingung in begrenzte Pakete. Dadurch
benötigt etwa eine Angebotsübersicht weniger Aufrufe des Datenbank-Workers.
Geprüft werden nur Zeilen mit den dafür geladenen Feldern. Ausdrücklich externe
Referenzen behalten ihre Ausnahme; fehlt eine andere erforderliche Referenz,
scheitert die gesamte lokale Transaktion. Auch ein Fehler in einem späteren
Paket verwirft die neue Projektion.

Der gemeinsame Lesepfad prüft vor der Entschlüsselung, ob der Absender unter der
im Chiffrat genannten Rechteregel schreiben durfte. Dafür werden historische
Regeln und die zugehörige Identität verifiziert; bei selbst angelegten Bereichen
kommt deren bestätigter Ursprung hinzu. Bereits geprüfte, unveränderliche
Bereichsnachweise können je API-Client innerhalb derselben Kontositzung und Signaturautorität
wiederverwendet werden. Der Speicher ist auf 2.048 Einträge begrenzt und enthält
weder Bereichsschlüssel noch aktuelle Zugriffsrechte. Schlüsselpakete werden
beim Öffnen auch bei einem bekannten Nachweis vollständig geprüft.
Eine Schlüsselrotation oder ein späterer
Rechteentzug macht frühere zulässige Änderungen dadurch nicht unlesbar.
Auch die Bestandsübernahme verwendet diese Prüfung.

`zerotrust.access.snapshot` liefert die Vertrauenskette, aktuelle Rechteregeln,
Bereichsnachweise und das gewünschte Verzeichnis gemeinsam. Die API liest und
prüft diesen Stand in einer Transaktion. Navigation und Datensammlungen nutzen
im Browser denselben Prüfer: Er bindet die Antwort an das angemeldete Konto,
dessen öffentliche Schlüssel und die hinterlegte Wiederherstellungsautorität.
Erst nach der Prüfung aller Signaturen und Generationen kann ein Inhaltsbereich
geöffnet werden. Ein Abbruch oder Kontowechsel verwirft auch späte Sammelantworten.
Für einen einzelnen Bereich ist ein begrenzter Abruf möglich; die Navigation
benötigt kein zusätzliches Bereichsverzeichnis.

Die Laufzeit ruft bis zu 16 Sammlungsseiten gemeinsam über
`zerotrust.objects.pages` ab. Die API prüft deren Rechte, verschlüsselte Inhalte
und Schlüsselpakete in demselben Transaktionsstand. Der Browser prüft weiterhin
jede Signatur, die Bindung der Schlüsselpakete und die entschlüsselten Inhalte.
Eine zusammengefasste Anfrage erlaubt keinen Zugriff auf zusätzliche Bereiche.
Fehlt etwa das Leserecht für eine enthaltene Kalkulation, liefert die API kein
Teilergebnis.

Eine Sammelantwort enthält höchstens 32 MiB. Überschreitet sie diese Grenze,
teilt der Client die Anfrage auf. Berechtigungsfehler, beschädigte Nachweise und
Versionskonflikte lösen diese Ausweichbehandlung nicht aus. Umfangreiche
historische Schlüsselverzeichnisse können weiterhin einzeln geladen werden.

Vor der gemeinsamen Ansicht werden die gelesenen Bereichsstände erneut geprüft.
Dafür genügt der Vergleich mit den zuvor bestätigten Versionen; unveränderte
Chiffrate müssen nicht noch einmal übertragen werden. Die Verarbeitung einzelner
Bereiche läuft mit höchstens vier parallelen Lesevorgängen. Scheitert ein Abruf,
werden keine weiteren gestartet. Bereits laufende Abrufe werden beendet, bevor
die Laufzeit ihre Zugriffskontexte schließt.

Bei einer vollständig geladenen Sammlung übergibt bereits der nächste Abruf
deren bekannten Stand. Ein unveränderter Bereich benötigt damit nur die
Versionsprüfung. Frisch geladene Berechtigungen werden auch dann übernommen,
wenn sich weder Inhalte noch Bereichsstände geändert haben.

Eine nach Projekt oder Dokumentart gefilterte Vorgangsliste liest zunächst die
geprüften Kopfdaten einschließlich festgeschriebener Rechnungsangaben. Die
übrigen Felder werden anschließend nur für passende Vorgänge geladen. Dabei
bleiben die Kopfdaten aller Kandidaten Teil der Prüfung; eine geänderte
Treffermenge führt zu einem erneuten Abruf. Zahlungsstände werden erst mit den
zugehörigen unveränderlichen Abrechnungsbelegen ausgewertet. Kundennamen werden
für die Liste gemeinsam geladen.

Für die Prüfung der angezeigten Dokumentbeträge teilt ein Listenabruf einen
verifizierten Zugriffskontext. Die Dokumente behalten eigene Sammlungen und
Schlüssel; das Schließen eines Dokuments beeinträchtigt die anderen nicht.
Ein Kontowechsel oder Abbruch entwertet den gesamten Kontext. Die API prüft
bei jedem weiteren Lesen und Veröffentlichen weiterhin die aktuellen Rechte.

Antworten der `zerotrust.*`-Pfade gelangen in der Webapp nicht in den
RPC-Antwortcache. Diese Metadaten müssen frisch vom Server kommen; ihre erneute
Serialisierung bringt für diesen Lesepfad keinen Nutzen. Die begrenzte
Wiederverwendung mathematisch geprüfter öffentlicher Signaturen bleibt davon
getrennt und ersetzt keine Aktualitätsprüfung.

Identische, gleichzeitig laufende Fachabfragen teilen ihre lokale Leseprüfung.
So benötigen etwa Verantwortlicher und Herausgeber derselben Buchung nur einen
Abruf desselben Benutzerprofils. Jeder Aufrufer erhält eine eigene Ergebniskopie;
nach Abschluss bleibt kein Ergebnis in dieser Ablage. Änderungsmeldungen und
Kontowechsel lösen laufende Einträge sofort aus der Wiederverwendung. Eine später
begonnene Abfrage liest damit wieder frisch.

Alte Daten benötigen weiterhin ihre signierten Rechteregeln, Zertifikate und
Ursprungsnachweise. Diese gehören zur Sicherung des verschlüsselten Bestands und
dürfen bei der Bereinigung technischer Tabellen nicht entfernt werden, solange
noch Chiffrate darauf verweisen. Grenzen der Aktualitätsprüfung beschreibt die
[Datenprüfung](verschluesselung-datenpruefung.md#verantwortung-der-clients).

Für Fachadapter mit derselben Abfrageschnittstelle bündelt `adapterRegistry.ts`
Routen, verzögertes Laden und technische Änderungsabhängigkeiten. Personal,
Tagesberichte, Regieberichte, Einsatzplanung und Abwesenheiten melden diese Angaben
jeweils einmal an. Die Registry teilt parallele Ladevorgänge und gibt auch einen
erst nach der Abmeldung fertig geladenen Adapter frei. Antworten eines früheren
Kontos gelangen nicht in den nächsten Arbeitsbereich. Inhaltsprüfung und
Schlüsselwahl bleiben Aufgabe des jeweiligen Adapters.

## Eine Änderung ausführen

Beim Lieferanten genügt nach der Prüfung der Formulareingabe beispielsweise:

```ts
await runtime.transaction([vendorRequest], tx => {
  tx.patch("product_vendors", { id: rawId }, {
    name: "Baustoffhandel Muster",
    modified_at: new Date().toISOString(),
  });
});
```

Die Laufzeit lädt eine geprüfte Ausgangsversion, ordnet die Felder ihrem
verschlüsselten Objekt zu und prüft den möglichen Folgezustand in DuckDB.
Anschließend erstellt sie die signierten Chiffrate und veröffentlicht sie mit
den zuvor gelesenen Bereichsversionen. Das Rücklesen muss dieselben Signaturen
liefern. Eine erfolgreiche HTTP-Antwort allein gilt nicht als Speichernachweis.
Eine verlorene Antwort kann deshalb trotzdem als erfolgreicher Abschluss erkannt
werden. Fremde Änderungen führen zu einem Versionskonflikt.

Beim Anlegen mehrerer Schlüsselbereiche bündelt `publishDomainDefinitions` bis
zu 64 öffentliche Definitionen über `zerotrust.domains.putMany`. Die API prüft
alle Signaturen, Empfänger und Anlegerechte in derselben Transaktion. Eine
ungültige Definition verhindert die Veröffentlichung der ganzen Gruppe.
Auch hier bestätigt der Browser die tatsächlich gespeicherten signierten
Definitionen. Geschäftsdaten und private Schlüssel gehören nicht in diese
Anfrage. Größere Verzeichnisse werden in begrenzten Gruppen vorbereitet; die
zugehörigen Geschäftsdaten werden anschließend gemeinsam veröffentlicht.

`tx.edit` ändert zusammengehörige Inhalte eines Objekts, etwa Produktkategorien.
`tx.create` legt ein neues Objekt an. Mehrere geänderte Objekte und Schlüsselbereiche
werden gemeinsam veröffentlicht. Wiederholungen eines Fachbefehls müssen ausdrücklich
über `retries` erlaubt werden; der Befehl muss dafür erneut ausführbar sein.
Ansichten und Transaktionen gelten nur innerhalb ihres Rückrufs. Daten für die
Oberfläche werden dort über `documents` oder `pick` als Kopien entnommen.
`view.can` liefert die geprüften Rechte für den geladenen Bereich, etwa für die
Bearbeitbarkeit eines Dokuments. Die eigentliche Schreibprüfung erfolgt weiterhin
beim Vorbereiten und Veröffentlichen der Änderung.

`tx.expect` bindet ein Formular an die ursprünglich gelesene Signatur oder
Revision. Über `verified` erhält der Aufrufer nach erfolgreicher Prüfung die
Signaturen der eigenen gespeicherten Änderungen. Damit kann ein geöffnetes
Organisationsformular weiter bearbeitet werden, ohne zwischenzeitliche Änderungen
einer anderen Ansicht zu übergehen.

Für zusammengesetzte Abläufe liefert `runtime.prepare` geprüfte, verschlüsselte
Änderungen samt ihren Ausgangsversionen. Die Projektanlage nutzt dies etwa beim
Übernehmen eines angenommenen Angebots: Projekt, Angebotszuordnung und getrennt
geschützte Register werden zusammen veröffentlicht. Vorbereitete Änderungen sind
vorher weder auf dem Server noch in anderen Ansichten sichtbar. Der Aufrufer muss
die vorbereiteten Gruppen auch nach einem Fehler mit `close` freigeben.

Eine Vorbereitung ohne Datenänderung behält ebenfalls ihre gelesenen
Bereichsstände. Damit kann etwa eine Erstberechnung von Abwesenheitsrechten gegen
genau die geprüften Personalzuordnungen veröffentlicht werden. Bei einer
Personaländerung verbindet ein autoritätssigniertes Transaktionsmanifest die
verschlüsselten Pakete, alle Ausgangsstände und die neue Rechteregel. Das gemeinsame
Speichern prüft anschließend sowohl die Objekte als auch die gespeicherte Regel.

Größere Änderungssätze werden in begrenzten Paketen vorbereitet. Diese bleiben
für andere Clients unsichtbar, bis die API alle aktuellen Rechte und
Ausgangsversionen erneut geprüft und der DuckDB-Dienst den gesamten Satz atomar
veröffentlicht hat. Ein Rechteentzug während der Vorbereitung verhindert damit
auch den späteren Abschluss. Geht nur die Antwort verloren, prüft der Browser
die tatsächlich gespeicherten Signaturen und den gegebenenfalls gemeinsam
bestätigten Regelstand.

Angebote, Aufmaße und Weitervergaben nutzen denselben Weg für ihre Kopf- und
Fachdaten. Ihre Datenmodelle ordnen die tatsächlich vorhandenen Spalten den
getrennten Freigaben zu. Dokumentdateien und Vorgangsbelege haben eigene
Namensbereiche; eine Angebotsliste entschlüsselt deshalb keine GAEB-Dateien.
Eine Statusänderung kann ihren Beleg und die zugehörigen Preisänderungen in einer
Veröffentlichung speichern. Der Fachbefehl behält dafür nur seine gelesenen
Ausgangsversionen, keinen eigenen dauerhaft gepflegten Datenbestand.

## Löschen mit eigenem Recht

Eine Projektlöschung benötigt Lesen und Löschen, aber kein Bearbeitungsrecht.
Der Fachadapter markiert das Objekt in derselben Transaktion wie andere Änderungen:

```ts
await runtime.transaction([projectRequest], tx => {
  tx.delete(projectRequest, projectRequest.area.prefix);
});
```

Die Laufzeit entfernt dessen Zeilen aus dem geplanten Datenbestand und prüft die
verbleibenden bekannten Beziehungen. Sie veröffentlicht anschließend einen
signierten Löschdatensatz im Format `sortsys-object-tombstone-v1`. Sein
verschlüsselter Inhalt ist leer. Die Signatur bindet auch dieses Format;
ein gewöhnlicher Datensatz lässt sich nicht ohne neue Signatur umetikettieren.
Die API verlangt für dieses Format genau einen 16 Byte langen GCM-Tag und prüft
das Löschrecht, die vorhandene Objektkennung und die erwartete Version. Sie
entschlüsselt dabei weder den alten noch den neuen Inhalt.

Vor dem Ausblenden prüft der Lesepfad Signatur, Schlüssel und das damalige
Löschrecht des Autors. Eine gültige Signatur eines bloßen Lesers genügt nicht.
Erst das Zurücklesen desselben signierten Löschdatensatzes bestätigt die Aktion,
auch nach einer verlorenen Speicherantwort. Neue Änderungen dürfen eine bereits
gelöschte Kennung nicht wiederverwenden. Bei einer normalen erneuten Anlage
entsteht eine neue Kennung.

Projekte, Kunden, Ansprechpartner, Bautagesberichte, Regieberichte sowie
Projektdateien und leere Ordner verwenden diesen Pfad. Unfreigegebene Kosten,
Regiestunden und Dateiblöcke müssen dafür nicht geöffnet werden. Die Löschung ist
logisch: frühere verschlüsselte Fassungen und nicht mehr zugeordnete Dateiblöcke
bleiben bis zu einer gesonderten Bereinigung erhalten. Der öffentliche
Löschstatus gehört wie Objektkennung und Änderungszeit zu den technischen Metadaten.

Die Verwaltungsmaske verwendet für Stammdaten, Projekte und Personal dieselbe
Rechteauswahl. Unter **Individuell** lassen sich Lesen, Anlegen, Bearbeiten und
Löschen einzeln setzen. So kann ein Konto ein Projekt lesen und löschen, ohne
seinen Inhalt bearbeiten zu dürfen. Einzelne Häkchen ändern nur die jeweils
betroffene Aktion; andere aktuelle Regeln bleiben erhalten. Die festen Profile
ersetzen dagegen bewusst den gesamten Aktionsumfang des ausgewählten Bereichs.
Zusätzliche bestehende Rechte für Bestätigungen und die Freigabeverwaltung sind
sichtbar, lassen sich hier aber noch nicht einzeln konfigurieren.

`AccessDraft` merkt sich die bearbeiteten Aktionen. `patchAccessRules` überträgt
sie auf die zuletzt verifizierten Regeln. `changeAreaActionAccesses` veröffentlicht
mehrere Bereichsänderungen gemeinsam und prüft die gespeicherte Signatur auch
nach einer verlorenen Antwort. Ändert sich der Leserkreis, folgt der bestehende,
wiederaufnehmbare Schlüsselwechsel; bis dahin bleiben betroffene Schreibzugriffe
gesperrt.

Produkte, Lieferanten und Preise behalten ihr eigenes signiertes Löschprotokoll
mit öffentlichen Referenzprüfungen. Der allgemeine Pfad darf diese Prüfungen
nicht umgehen. Für einzelne Unterzeilen in gemeinsam verschlüsselten
Sammelobjekten reicht er ebenfalls nicht: Die betreffenden Adapter müssen ihre
Objekte feiner aufteilen oder einen eigenen Löschablauf anbinden. Dazu gehören
noch einzelne Werkzeugabläufe.

## Teilfreigaben und lokale Prüfung

Die [Einsatzplanung](verschluesselte-einsatzplanung.md) verwendet denselben
Datenkern für Einsätze und Baustellensperren. Ein Projektwechsel kombiniert
Löschmarkierung und neue Zuordnung atomar; getrennte Speicherkennungen erhalten
die öffentliche Einsatzkennung auch beim Rückverschieben.
[Abwesenheiten](abwesenheiten-protokoll.md) haben getrennte Antrags- und
Entscheidungsbereiche je Person. Automatische Freigaben aus der Vorgesetztenzuordnung
werden getrennt von manuellen Ausnahmen nachgeführt.

Ein Lieferschein kann Mengen und Kommentare freigeben, während seine Preise
getrennt verschlüsselt bleiben. Das Mengenmodell nimmt die Preisspalte aus seiner
Zeilenansicht heraus. Das Preismodell ordnet die freigegebenen Preise denselben
Positionsschlüsseln zu. Ein Patch gelangt ausschließlich an das Objekt, dem das
betroffene Feld gehört.

Bautagesberichte verwenden dieselbe Trennung für geleistete Stunden und interne
Stundensätze. Die Formulare behalten die Kennungen vorhandener Arbeitszeitzeilen
bei und lassen Kosten ohne Bearbeitungsfreigabe weg. Ein Mitarbeiterwechsel
bekommt eine neue Zeilenkennung, damit kein verborgener Satz auf die andere Person
übergeht. Datumsänderungen werden zusammen mit den übrigen Berichten auf einen
bereits belegten Berichtstag geprüft.

`aggregateRows` prüft bei Lieferscheinen und Tagesberichten nicht nur das Schema
der Unterzeilen, sondern auch deren Zugehörigkeit und eindeutige Kennung.
`existingAggregateRows` lässt bei einer Ersetzung nur Kennungen aus dem bisherigen
Dokument zu. Neue Zeilen erhalten eigene Kennungen. Damit können Formulare auch
beim Umsortieren keine fremden oder verborgenen Werte über die Listenposition
zuordnen.

Die Grundbereiche stehen in `CREATION_FACETS.project`, die eigenständigen
Berichtsbereiche in `PROJECT_MODULE_FACETS`. `projectScope` bindet beide an
kanonische Projektkennungen. Projektanlage,
Freigaben und Fachmodelle verwenden diese Bindung; die jeweiligen Fachmodelle
behalten ihre eigenen Objektnamensräume.

Regieberichte haben einen eigenen Projektbereich für Material und
Sonderposten; die datierten Arbeitszeiten verwenden darin einen getrennten
Schlüssel. Lieferscheine und Tagesberichte besitzen unabhängige Bereiche. Ein
Materialeintrag lässt sich deshalb ohne Stundenfreigabe korrigieren. Eine reine
Stundenänderung schreibt den Materialteil nicht erneut. Ein Wochenwechsel muss
auch die Stunden aktualisieren und wird gemeinsam mit ihnen veröffentlicht.
Die Anlage behält ihre Vorgangskennung über Speicherwiederholungen hinweg.
Wenn auch das Rücklesen nach einer verlorenen Antwort scheitert, bestätigt ein
weiterer Versuch denselben Bericht, statt einen zweiten anzulegen. Geänderte
Inhalte unter derselben Kennung werden abgewiesen.

Client-Skripte verwenden ebenfalls diesen Datenkern. Ihr Modell prüft Namen,
Beschreibung, Code und Urheberfelder nach dem Entschlüsseln. Die Bestandsübernahme
erhält ursprüngliche Urheber und Zeitpunkte; normale Änderungen setzen den
tatsächlichen Bearbeiter. Die API erhält weder Skripttexte noch Suchbegriffe.
Ein nativer Test prüft getrennte Rechte und Schlüsselwechsel über zwei
API-Instanzen sowie den Erhalt nach zwei Mandanten-Recoveries.

`remove` löscht gewöhnliche Modelle durch eine signierte Löschmarkierung und
prüft bei Wiederholung diese Markierung erneut. Ein fehlendes Objekt allein
bestätigt keine Löschung. `removeStock` verwendet dagegen das gesonderte
Katalogprotokoll mit signierten Referenzen für Produkte, Lieferanten und Preise.
Die beiden Speicherwege dürfen nicht gegeneinander ausgetauscht werden.

Die gemeinsame Auswahl historischer Preise vergleicht Zeitpunkte einschließlich
Mikrosekunden und löst gleiche Zeitpunkte über die numerische Kennung auf.
Lieferscheine dürfen den frühesten späteren Preis verwenden, wenn vorher kein
Preis bekannt war. Regieberichte verwenden nur Preise bis zum Ende der jeweiligen
Berichtswoche. Fehlende Preisrechte liefern keine vermeintlichen Nullkosten.

Die DuckDB-Wasm-Parameterschnittstelle erhält Gleitkommazahlen als exakt
rücklesbare Dezimalschreibweise mit einer expliziten Umwandlung nach `DOUBLE`.
Das umgeht eine Rundung in ihrem JSON-Parameterdecoder. Ganzzahlige Kennungen
und exakte Geldbeträge behalten weiterhin ihre eigenen Schematypen.

Ein nicht geladenes Feld liefert `UNLOADED`. Es ist kein SQL-`NULL`. `require`
verlangt ein geladenes Feld und `pick` verlangt mehrere. Interne SQL-Abfragen
müssen ihre gelesenen Felder angeben, damit fehlende Freigaben vor der Abfrage
auffallen. Diese Angabe gehört zum vertrauenswürdigen Anwendungscode und wird
nicht aus beliebigem SQL abgeleitet.

Eine Anfrage kann über `ids` einzelne Objekte nachladen. Sie teilt denselben
Bestand mit späteren vollständigen Anfragen; ein teilweise geladener Bestand
wird dabei nicht als vollständige Liste ausgegeben. Ändert sich die Bereichsversion,
verwirft der Kern ältere Teilbestände. SQL-Abfragen über nicht geladene oder nur
teilweise geladene Tabellen werden abgewiesen. Für Schreibprüfungen auf zusätzliche
eindeutige Schlüssel muss der betroffene Bestand vollständig geladen sein.

Nach einer Aktualisierungsanforderung bleiben alte Bereichsstände nur zum
Vergleich ihrer Versionsnummern im Cache. Bis zur erneuten Prüfung gehören sie
nicht zur Zeilenansicht oder zu den lokalen SQL-Prüfungen. Dadurch kann eine
bereits zurückgegebene Werkzeugbuchung aus einem alten Cache keine neue Ausgabe
blockieren, wenn zunächst nur der Werkzeugkopf nachgeladen wurde. Modelle geben
ihre Tabellen je Schlüsselbereich an; ein nicht freigegebener Zahlungsbereich
wird deshalb auch bei einer Zählabfrage nicht als leerer Bestand behandelt.

`createMany` übernimmt größere Mengen mit einer gemeinsamen Prüfung. SQL-Zeilen,
Verschlüsselung und Uploads werden in begrenzten Blöcken verarbeitet. Bei vielen
Produkt- und Preisobjekten prüft der Speicheranschluss die signierten öffentlichen
Verweise gesammelt gegen die vorbereiteten Chiffrate. Andere Objekte, darunter
der verschlüsselte Importbeleg, werden weiterhin vollständig zurückgelesen.

Die lokale Prüfung ersetzt keine serverseitige Prüfung geheimer Geschäftsdaten.
Bedingungen mit ungelesenen Feldern bleiben ungeprüft. Externe Referenzen dürfen
nur ausdrücklich im Modell zurückgestellt werden, etwa ein Lieferscheinverweis
auf einen nicht freigegebenen Benutzer. Geschäftsregeln können zusätzlich die
benötigten Referenzbereiche laden; deren Versionen gehen dann in die gemeinsame
Veröffentlichung ein. Ein berechtigter, veränderter Client kann weiterhin fachlich
falsche Inhalte signieren. Die API prüft Signaturen, Schreibrechte und technische
Versionen, ohne diese Inhalte zu entschlüsseln.

## Geprüfte Inhalte in der Oberfläche

`businessClient.context` stellt die Lebensdauer des aktuellen Inhaltszugangs als
`AbortSignal` bereit. Der React-Anschluss `useProtectedState` bindet lokale
Ansichtsdaten an genau diesen Zugang. Bei einem Wechsel verschwinden bisherige
Werte sofort aus der Darstellung. Ein asynchroner Rückruf des alten Zugangs kann
sie nicht in den neuen Zustand schreiben. Chatansicht und Chatübersicht verwenden
diesen Anschluss für geladene Inhalte; der Chat verwirft auch den bisherigen
Anfragezwischenspeicher. Eine erneute Anzeige braucht wieder eine geprüfte Abfrage.

Die Bestandskopierer verwenden denselben Veröffentlichungsbaustein wie die
laufenden Fachbefehle. Sie prüfen die gespeicherten Signaturen eines Pakets auch
nach einer verlorenen Antwort. Die nächste Teilübernahme verwendet den erneut
gelesenen Bereichsstand. Ein bestätigter, aber nicht tatsächlich gespeicherter
Datensatz gilt damit nicht als erfolgreich übernommen.

## Lebensdauer und Umstellungsstand

Mehrere Ansichten über denselben API-Client teilen eine Laufzeit und eine gemeinsam
genutzte DuckDB-Datenbank im Arbeitsspeicher. Neu geöffnete Ansichten lassen vorhandene
Bereichsversionen erneut prüfen. Eine geschlossene Ansicht beendet keine andere.
Abmeldung, Kontowechsel und ein ersetztes Anmeldetoken sperren die alte Laufzeit.
Bei einer Änderung der Freigaben werden die bisherigen Projektionen verworfen.
Klartext wird weder in IndexedDB noch in OPFS abgelegt.

Die bisherigen Adapter für Produkte, Lieferanten, Preisaufzeichnungen und
Preisimporte, Ansichtseinstellungen, Organisation, Kunden, Kontakte, Personal, Projekte
und kaufmännische Vorgänge nutzen diesen Kern für ihre Änderungen. Auch
Druckvorlagen und ihr Anlagenverzeichnis verwenden die gemeinsame Laufzeit;
für reine Dokumentmodelle ohne Tabellen ist keine SQL-Projektion nötig.
Die Werkzeugverwaltung ist ebenfalls angeschlossen; ihre noch fehlenden
Freigabeabläufe beschreibt die [Werkzeugübersicht](verschluesselte-werkzeuge.md).
Bei Lieferscheinen übernimmt er das Lesen und Zusammenführen der getrennten Mengen-
und Preisbereiche. Deren Schreibbefehle, weitere Fachmodule und die Dokumenteditoren
sind noch nicht vollständig auf diese Laufzeit zurückgeführt. Die Werkzeugoberfläche
verwendet den verschlüsselten Adapter für Anlage, Änderung und Buchungen. Der
Browsertest prüft außerdem, dass die Bearbeitung ihrer Stammdaten ohne lesbare
Kosten weder Kostenfelder anzeigt noch sie beim Speichern mitsendet.
Auch die Personalbearbeitung ordnet Namensdaten, Personalangaben und interne
Stundensätze getrennten Objekten zu. Dieselbe Feldzuordnung verhindert hier das
Überschreiben nicht geladener Werte; das Fachmodul braucht dafür keine eigene
Zusammenführung von Profilkopien.

Besuchsverläufe, zuletzt verwendete Aktionen und fixierte Dashboard-Einträge
verwenden ebenfalls dieselbe Laufzeit. Zwei begrenzte Verlaufslisten und die
Fixierungen liegen getrennt von den GAEB-Ansichtseinstellungen im persönlichen
Schlüsselbereich. Ergänzungen und Umordnungen bearbeiten den jeweils geprüften
Stand; sie führen keine eigene Warteschlange für Klartextkopien ein.
