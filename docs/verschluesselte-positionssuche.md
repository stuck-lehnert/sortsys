# Leistungen aus früheren Dokumenten übernehmen

Die Positionssuche im GAEB-Editor findet Kurztexte und Beschreibungen in
freigegebenen Vorgangsdokumenten und GAEB-Projektdateien. So lässt sich eine
bereits verwendete Leistungsbeschreibung für ein neues Angebot übernehmen.
Eine Suche nach „Laib vorbereit“ findet beispielsweise eine Position, deren
Beschreibung „Laibungen sorgfältig vorbereiten“ enthält. Die Auswahl übernimmt
Kurztext, Beschreibung und Einheit, keine alten Mengen oder Preise.

Die Webapp liest die verschlüsselten Quellen und bildet die Treffer im Browser.
Suchbegriffe, Dateinamen und Positionstexte werden dabei nicht an die bisherige
serverseitige Positionssuche gesendet. Der XML-Parser läuft in einem lokalen
Worker; er lädt keine externen Ressourcen und weist DTD- oder
Entity-Deklarationen zurück.

Bei einem Vorgang müssen Grunddaten und Leistungsumfang lesbar sein. Für den
Suchlauf wird nur der Textteil des Dokuments geöffnet, auch wenn zusätzlich
Preis- oder Mengenfreigaben bestehen. Unbekannte XML-Erweiterungen werden dafür
nicht entschlüsselt. Bei Projektdateien gilt dagegen die Freigabe für die ganze
Datei; ihre Verschlüsselung trennt die enthaltenen Preise nicht einzeln ab.
Auch die Händlerformate X93, X94, X96 und X97 trennen Positionstexte,
Vertragsmengen und Preisangaben. Artikel- und Positionsnummern gehören dort zum
Leistungsumfang; Netto- und Angebotspreise sowie die Preisbasis zur Beschaffung.

Die Treffer erscheinen nach dem jüngsten Quelldokument. Gleiche Kombinationen
aus Kurztext, Beschreibung und Einheit erscheinen einmal; höchstens 20 Treffer
werden angeboten. Alle eingegebenen Wortanfänge müssen im Kurztext oder in der
Beschreibung vorkommen. Die Suche verwendet keine sprachabhängige Wortstamm-
oder Ähnlichkeitssuche.

Ein noch nicht gelesener Bestand wird in Schritten von vier Dokumenten
durchsucht. Die Auswahl lädt weitere Schritte selbst nach, bis die Suche
abgeschlossen ist oder die 20 jüngsten Treffer feststehen. Bereits geprüfte
Textdaten werden bis zu einem Umfang von 32 MiB zwischengespeichert; größere
Quellen lassen sich durchsuchen, ohne sie in diesem Zwischenspeicher zu halten.
Auf einem neuen Gerät müssen die freigegebenen Inhalte zunächst geladen werden.
Ein geänderter Suchbegriff bricht überholte Dateiarbeiten und XML-Worker ab;
überholte wartende Suchläufe werden übersprungen.

Der Index bleibt im Arbeitsspeicher. Es entsteht keine unverschlüsselte
Positionsdatenbank in IndexedDB oder Local Storage. Änderungen und gelöschte
Dateien aktualisieren das Quellverzeichnis über die verschlüsselten
Änderungshinweise; eigene Speichervorgänge berücksichtigen sie unmittelbar.
Ohne neue Änderungshinweise brauchen weitere Suchbegriffe das Verzeichnis nicht
erneut zu laden. Ein Konto- oder Zugriffswechsel entfernt den Index und verwirft
verspätete Ergebnisse. Nicht lesbare Bereiche werden nicht durchsucht; ein
beschädigter freigegebener Quellstand führt zu einer Fehlermeldung.
