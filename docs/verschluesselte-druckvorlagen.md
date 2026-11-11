# Druckvorlagen und Briefpapier

Unter Verwaltung → Organisation → Dokumentvorlagen lassen sich Briefkopf,
Fußzeile und Tabellen für Angebote, Aufmaße und weitere GAEB-Dokumente gestalten.
Links steht der Typst-Code im Monaco-Editor, rechts die PDF-Vorschau. Firmenname
und Anschrift stammen aus den Organisationseinstellungen. Ein Logo oder ein
vorhandenes PDF-Briefpapier lässt sich als Vorlagendatei hinzufügen und über
„Einbinden“ im Code verwenden.

Die vorhandenen Funktionen der Vorlage können zum Beispiel so angepasst werden:

```typst
#let document-header(data) = [
  #data.sender.name
  #h(1fr)
  #box(asset("Logo.png", width: 25mm, height: 8mm, fit: "contain"))
]
#let document-footer(data) = context align(right)[
  Seite #counter(page).display("1")
]
#let table-style = (stroke: 0.3pt + gray, inset: 4pt)
```

Die Box hält das Logo in derselben Zeile wie den Text. Für einen höheren
Briefkopf muss der obere Seitenrand in `document-style` mitwachsen.

Die Oberfläche gibt „Vorlage speichern“ nach einer erfolgreichen Vorschau frei.
Ein fehlerhafter Entwurf bleibt im Editor erhalten; die letzte gültige Vorschau
bleibt sichtbar. Beim Speichern wird die gelesene Version des Typst-Codes
verglichen. Gleichzeitige Änderungen am Code überschreiben sich nicht
unbemerkt. Eine Anlage kann unabhängig davon ergänzt werden, ohne einen
zwischenzeitlich gespeicherten Code zurückzusetzen.

Wenn sich Freigaben während der Bearbeitung ändern, prüft der Editor den Zugang
erneut. Bei weiterhin bestehendem Lesezugriff im selben Konto bleibt der eigene
Entwurf erhalten. Fehlt der Zugriff oder wird das Konto gewechselt, entfernt der
Editor den Entwurf und die Vorschau. Eine inzwischen veröffentlichte Änderung
verlangt vor dem Speichern weiterhin eine bewusste Konfliktlösung.

## Ablage und Freigaben

Typst-Code und Anlagenverzeichnis liegen im verschlüsselten Bereich
`organization:attachment`. Bilder und PDFs werden im Browser geprüft und in
unveränderliche, verschlüsselte Dateiblöcke zerlegt. Der signierte Katalog enthält
die Prüfsummen der zugehörigen Blöcke. Die API erhält keine Dateinamen, Medien
oder Typst-Inhalte im Klartext. Ihre Aufgabe beschränkt sich auf Freigaben,
Signaturen und technische Versionen.

Die normale Einladung gibt diesen Bereich zum Lesen frei. Mitarbeitende können
damit die Unternehmensvorlage beim Drucken verwenden. Änderungen verlangen eine
signierte Schreibfreigabe; eine alte Administrationsrolle allein genügt nicht. Das
Rechnungsnummernschema hat weiterhin einen anderen Schlüssel.

Vorlagencode und Anlagenverzeichnis verwenden dieselbe Datenlaufzeit wie die
übrigen verschlüsselten Fachdaten. Die Laufzeit prüft gelesene Versionen,
Schreibrechte und bestätigte Veröffentlichungen. Der Vorlagenadapter hält
keinen eigenen Inhaltszwischenspeicher und keine eigene Schreibwarteschlange.
Die Dateiblöcke bleiben ein eigener Speicherzugriff; ihr Katalogeintrag wird
erst nach der bestätigten Ablage veröffentlicht.

Eine Datei mit demselben Namen ersetzt die bisherige Anlage erst nach ihrer
verschlüsselten Ablage und dem bestätigten Speichern des Katalogs. „Entfernen“
nimmt die Datei aus dem aktuellen Katalog. Bereits gespeicherte Blöcke werden
dabei noch nicht physisch gelöscht; ihre spätere Bereinigung gehört zum
gesonderten Ablauf für alte Dateiversionen.

## Vorschau und Verarbeitung

Vorschau und Druck laufen im Browser. Vorlagendateien werden über private
Dateiverweise geöffnet, ohne öffentliche Download- oder Upload-URLs für ihren
Klartext zu erzeugen. PDF-Seiten werden lokal in Bilder gerendert. Der
Zwischenspeicher für diese Bilder ist an den aktuellen Zugang gebunden und
begrenzt. Ein Kontowechsel oder eine Änderung der Freigaben verwirft ihn und die
angezeigte Vorschau. Spät eintreffende Antworten dürfen keinen alten Inhalt in
den neuen Zugang übernehmen. Der Typst-Compiler löscht seine Dateizuordnungen
und Quellen vor und nach jedem Durchlauf.

Unterstützt werden PNG, JPEG, WebP, GIF, statische SVG-Dateien und PDF. SVG-Dateien
dürfen eingebettete Rasterbilder und Verweise innerhalb derselben Grafik
enthalten. Skripte, Ereignisbehandlungen, Animationen und externe Ressourcen
werden zurückgewiesen. Zum Rendern entsteht eine statische SVG-Kopie mit
eindeutigem Namensraum; nicht sichtbare Hersteller-Metadaten bleiben im
verschlüsselten Original erhalten. Die Größenprüfung erlaubt höchstens 20 MiB je Anlage,
100 Seiten je PDF und 128 MiB an vorbereiteten Bilddaten pro Drucklauf. Ein
Anlagenverzeichnis enthält höchstens 1.000 Dateien.

Die Bestandsübernahme kopiert den gespeicherten Typst-Code und die aktuell
freigegebenen Anlagen aus dem eingefrorenen Altbestand. Bild- und PDF-Originale
bleiben bytegetreu erhalten. Nicht abgeschlossene Uploads und ersetzte
Altdateien bleiben zunächst im bisherigen Bestand erhalten. Die vollständige
Umstellung mit Freigabe und Löschung der alten Klartextbestände ist noch nicht
abgeschlossen. Die API kann gültig signierte, aber fachlich fehlerhafte Inhalte
weiterhin nicht selbst prüfen.
