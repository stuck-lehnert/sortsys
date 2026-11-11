# Gemeinsamer Datenkern im Browser

Die Datenlaufzeit unter `sortsys-webapp-v2/app/lib/data/runtime` verbindet das
abgeleitete Geschäftsschema mit dem verschlüsselten Objektspeicher. Fachmodule
beschreiben ihre Daten und ändern sie in Transaktionen. Sie brauchen dafür keine
eigene Datenbank, Schlüsselverwaltung, Schreibwarteschlange oder Cache-Pflege.

Ein Datenmodell legt das Dateiformat und die Bindung eines Objekts an seinen
Schlüsselbereich fest. Enthält es vollständige `sortsys-row-v2`-Zeilen, findet die
Laufzeit deren Tabellen, Schlüssel und Felder automatisch. Die Typen, Längengrenzen,
Referenzen und SQL-Bedingungen stammen aus dem generierten Geschäftsschema.
Zusätzliche Fachregeln bleiben in der Modellprüfung oder im Fachbefehl.

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

Angebote, Aufmaße und Weitervergaben nutzen denselben Weg für ihre Kopf- und
Fachdaten. Ihre Datenmodelle ordnen die tatsächlich vorhandenen Spalten den
getrennten Freigaben zu. Dokumentdateien und Vorgangsbelege haben eigene
Namensbereiche; eine Angebotsliste entschlüsselt deshalb keine GAEB-Dateien.
Eine Statusänderung kann ihren Beleg und die zugehörigen Preisänderungen in einer
Veröffentlichung speichern. Der Fachbefehl behält dafür nur seine gelesenen
Ausgangsversionen, keinen eigenen dauerhaft gepflegten Datenbestand.

## Teilfreigaben und lokale Prüfung

Ein Lieferschein kann Mengen und Kommentare freigeben, während seine Preise
getrennt verschlüsselt bleiben. Das Mengenmodell nimmt die Preisspalte aus seiner
Zeilenansicht heraus. Das Preismodell ordnet die freigegebenen Preise denselben
Positionsschlüsseln zu. Ein Patch gelangt ausschließlich an das Objekt, dem das
betroffene Feld gehört.

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

## Lebensdauer und Umstellungsstand

Mehrere Ansichten über denselben API-Client teilen eine Laufzeit und eine gemeinsam
genutzte DuckDB-Datenbank im Arbeitsspeicher. Neu geöffnete Ansichten lassen vorhandene
Bereichsversionen erneut prüfen. Eine geschlossene Ansicht beendet keine andere.
Abmeldung, Kontowechsel und ein ersetztes Anmeldetoken sperren die alte Laufzeit.
Bei einer Änderung der Freigaben werden die bisherigen Projektionen verworfen.
Klartext wird weder in IndexedDB noch in OPFS abgelegt.

Die bisherigen Adapter für Produkte, Lieferanten, Preisaufzeichnungen und
Preisimporte, Ansichtseinstellungen, Organisation, Kunden, Kontakte, Projekte
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
