# Laufende LLM-Anfragen im Browser

Der Browser stellt die entschlüsselten Daten für eine LLM-Anfrage bereit. Der
Webapp-Tab muss deshalb geöffnet bleiben. Ein interner Seitenwechsel darf eine
laufende Chat-Anfrage dagegen nicht beenden. Die Anfrage gehört zur Sitzung,
nicht zur gerade angezeigten Chatseite.

Beim Einlesen bleibt ein Fortschrittsdialog bis zum fertigen Ergebnis geöffnet.
Er hat keinen Schließen-Knopf und reagiert weder auf Escape noch auf einen Klick
außerhalb. Auch bei einem internen Routenwechsel bleibt er geöffnet und die
Verarbeitung läuft weiter. Im Dialog steht, dass Neuladen oder Schließen des
Tabs die Verarbeitung unterbricht. Während einer laufenden Anfrage fordert der
Browser beim Verlassen der Seite zusätzlich eine Bestätigung an, soweit er
solche Dialoge zulässt. Wird die Navigation abgebrochen, läuft die Anfrage
weiter. Ein Wechsel zu einem anderen Browser-Tab beendet sie ebenfalls nicht.

## Was bereits umgesetzt ist

Die [Laufzeitverwaltung](../sortsys-webapp-v2/app/lib/llmActivity.ts) hält nur
Fortschrittsangaben im Speicher. Beim tatsächlichen Verlassen des Dokuments oder
beim Wechsel des entschlüsselten Kontos bricht sie die Vorgänge über ein
`AbortSignal` ab und verwirft verspätete Antworten. Das gilt auch, wenn der
Browser die Seite in seinen Vorwärts-/Rückwärts-Cache aufnimmt. Ein
zurückkehrender Chat-Abonnent kann einen weiterhin laufenden Vorgang wieder
anzeigen.

Der [Einlese-Ablauf](../sortsys-webapp-v2/app/lib/importProcessing.ts) umfasst
Dateivorbereitung, Live-Anfrage, Prüfung und verschlüsseltes Speichern. Erst das
erneute Lesen des gespeicherten Ergebnisses beendet den Fortschrittsdialog.
Browsertests prüfen den gesperrten Dialog, den Hinweis, interne Navigation und
den Abbruch beim Verlassen des Tabs.

## Transport zwischen Browser, API und Modell

Der [Live-Transport](../sortsys-api-v2/rust-api/src/llm/live.rs) verwendet eine
WebSocket-Verbindung pro Anfrage. Der Browser bestätigt eine kurzlebige,
einmalig verwendbare Eintrittskarte mit seiner Kontosignatur. Die API prüft
Sitzung, LLM-Freigabe und aktuelle Wiederherstellungsgeneration. Ausgewählte
Originale kommen in begrenzten Blöcken an und bleiben für diesen Aufruf im RAM.

OpenAI und Anthropic verwenden weiterhin ihre MCP-Anbindung. Der
OpenRouter-Adapter ruft dieselbe authentifizierte HTTP-MCP-Schnittstelle auf.
MCP-Werkzeuge beziehen Fachinhalte aus dem verbundenen Browser; sie lesen dafür
keine alten Klartexttabellen. Beim Einlesen ist ausschließlich die Produktsuche
freigegeben. Allgemeine Chat-Abfragen und Änderungsvorschläge müssen in den vom
Browser angegebenen Umfang passen. Ein Vorschlag führt keine Änderung aus.

Ein MCP-Aufruf darf auf einer anderen API-Instanz eintreffen. Eine signierte
Routingangabe führt ihn zur Instanz mit der Browser-Verbindung zurück. Dabei
gibt es höchstens eine Weiterleitung, keine Weiterleitung von HTTP-Redirects und
keine Ablage des Kontextes in einer gemeinsamen Datenbank. Die Instanzen müssen
einander direkt erreichen können. Standardmäßig verwendet die API ihre zur
DuckDB-Dienst gerichtete Netzwerkadresse und den gebundenen Port.
`LLM_LIVE_INTERNAL_URL` kann bei anderer Netzführung eine eindeutige Adresse
dieser Instanz vorgeben. Eine gemeinsame Load-Balancer-Adresse eignet sich dafür
nicht.

Ein Verbindungsabbruch verwirft die laufende Provider-Anfrage und offene
MCP-Rückfragen. Die Gesamtlaufzeit ist auf zehn Minuten begrenzt. Ob ein
externer Modellanbieter seine Berechnung oder Abrechnung daraufhin ebenfalls
beendet, hängt von dessen Dienst ab. Dauerhaft gespeichert werden nur technische
Eintritts- und Nutzungsdaten, etwa Tokenzahlen und feste Fehlercodes. Antworten,
Dateien, Werkzeugergebnisse und Fehlermeldungen des Modells gehören nicht in
diese Tabellen oder in Protokolle.

Freigaben, verbrauchte Verbindungstickets und Tokenzahlen liegen im gemeinsamen
DuckDB-Dienst. Damit gilt die Begrenzung auf vier gleichzeitig laufende Anfragen
je Mandant auch bei mehreren API-Instanzen. Nach einem Prozessabbruch läuft die
Reservierung nach zehn Minuten aus. Die Monatsquote berücksichtigt den vom
Modellanbieter zurückgemeldeten Verbrauch; bereits laufende Anfragen können die
verbleibende Quote überschreiten.

Anbieterzugänge und die Auswahl des Modells werden in der Betreiberverwaltung
festgelegt. Gespeicherte API-Schlüssel sind mit `LLM_ENCRYPTION_KEY`
verschlüsselt; alle API-Instanzen benötigen dafür dasselbe Geheimnis. Dieser
Schlüssel schützt ausschließlich die Zugangsdaten zu Modellanbietern. Er
entschlüsselt keine Mandanteninhalte. Eine LLM-Freigabe je Mandant bleibt
erforderlich.

Die monatliche Nutzungsübersicht unter Verwaltung bleibt für Administratoren
verfügbar. Sie enthält nach Anbieter, Modell und Verwendungszweck gruppierte
Anfragen und Tokenzahlen. Der Zugriff umfasst weder Antworten und Originale noch
gespeicherte Fehlertexte. Normale Benutzerkonten erhalten diese Übersicht nicht
allein durch ihre LLM- oder Inhaltsfreigaben.

## Einlesen und persönlicher Verlauf

Die Einlesen-Seite übergibt ausgewählte Dateien an den
[Ablauf im Client](../sortsys-webapp-v2/app/lib/data/imports.ts). Ausgewählte
PDF- und Bilddateien werden innerhalb der laufenden Verbindung bereitgestellt.
JPEG-Fotos werden vorher anhand der Kameraorientierung ausgerichtet; das Modell
erhält eine Kopie mit aufrechten Bilddaten. XLSX-Dateien liest ein
Browser-Worker als Tabellenwerte, einschließlich gespeicherter Formelresultate;
Formeln werden dabei nicht ausgeführt. Die Erkennung erhält diese Werte als
Text. Dateigröße, entpackte Daten und Textumfang sind begrenzt. Die Originale
werden für diesen Vorgang nicht in den Objektspeicher geladen.

Die Webapp prüft die Antwort und gleicht Produkte, Einheiten und Mengen mit dem
lokalen Katalog ab. Vor dem Speichern werden Katalog und Berechtigungen erneut
gelesen, damit Änderungen während einer längeren Anfrage berücksichtigt werden.
Verschachtelte Verpackungseinheiten werden in die Basiseinheit umgerechnet. Eine
nicht prüfbare Zuordnung bleibt bei Lieferscheinen als Sonderposten erhalten;
Preise brauchen eine nachvollziehbare Einheitenumrechnung. Das Ergebnis lässt
sich anschließend im bisherigen Lieferschein- oder Preisdialog prüfen.

Ergebnisse und Dateinamen liegen in einem eigenen verschlüsselten Bereich je
Benutzer. Der Produktschlüssel öffnet diesen Verlauf nicht. Ein fehlgeschlagener
Vorgang bekommt eine feste Meldung; Fehlermeldungen des Providers werden nicht
in den Verlauf kopiert. Ein erneuter Client kann fertige Ergebnisse aus dem
verschlüsselten Speicher öffnen. Die Liste aktualisiert sich nach einem
Abschluss ohne das bisherige Status-Polling. Die
[Benutzereinladung](benutzerfreigaben.md) kann einen eigenen Bereich für den
persönlichen Assistentenbereich bereitstellen. Dessen signierte Lese- und
Schreibrechte steuern auch die Nutzung des Assistenten. Für die Produktsuche
beim Einlesen wird zusätzlich Katalogzugriff geprüft. Eine Freigabe für den
Assistenten öffnet keine weiteren Fachdaten.

Bei einem Rechteentzug prüft eine laufende Anfrage die aktuelle Freigabe über
den gemeinsamen Änderungsstrom erneut. Die API verwirft die Modellanfrage und
offene Werkzeugaufrufe, auch wenn der Browser seine Verbindung offen hält.
Dieser Abgleich nutzt denselben Mandantenstrom wie die
WebSocket-Benachrichtigungen.

Die Übernahme persönlicher Einleseverläufe aus einer alten Sicherung muss noch
an die [Ersteinrichtung eines Mandanten](bestandsumstellung.md) angeschlossen
werden. Dazu gehören Dateinamen, Benutzerzuordnung, genaue Zeitpunkte und die
Unterscheidung zwischen abgeschlossenen, unterbrochenen und fehlerhaften
Vorgängen.

## Chat und freigegebene Änderungen

Der Chat verwendet denselben Live-Transport. Titel, Nachrichten und Vorschläge
werden als einzelne verschlüsselte Objekte im persönlichen Benutzerbereich
gespeichert. Die Übersicht liest nur die Titel; eine neue Nachricht schreibt
nicht den gesamten bisherigen Verlauf erneut. Alte große Antworten werden bei
Bedarf aus dem mitgesendeten Kontext entfernt. Im gespeicherten Verlauf bleiben
sie erhalten.

Aktuell kann der Chat den geschützten Produktkatalog durchsuchen und Vorschläge
zum Anlegen, Bearbeiten und Verschlagworten von Produkten vorbereiten. Die
Webapp prüft einen Vorschlag vor seiner Anzeige gegen das lokale Datenschema.
Erst die Annahme führt die Änderungen aus. Fachänderungen und
Ausführungsnachweis werden gemeinsam gespeichert, damit eine verlorene Antwort
keine doppelte Ausführung verursacht. Ändert ein anderer Client zwischen Prüfung
und Speicherung den Katalog, wird das gesamte Schreibpaket abgewiesen. Ein
gelöschter Chat lässt sich durch eine verspätete Modellantwort nicht
wiederherstellen. Das Löschen setzt bisher eine signierte Löschmarkierung. Die
verschlüsselten Verlaufsobjekte bleiben bis zur noch ausstehenden
Speicherbereinigung erhalten.

Die Bestandsübernahme ordnet vorhandene Chats wieder ihrem ursprünglichen
Benutzerkonto zu. Nachrichten, IDs und die Reihenfolge nach Mikrosekunden
bleiben erhalten. Bei gleichen Zeitpunkten entscheidet die numerische ID. Alte
Vorschläge behalten ihren ursprünglichen Datensatz einschließlich Entscheidung
und Kommentar. Ein angenommener Vorschlag ohne gespeichertes Ergebnis wird als
solcher angezeigt; die Oberfläche behauptet keine belegte Ausführung und erzeugt
keine Ergebnislinks. Auch Vorschläge ohne zugeordnete Assistentennachricht
bleiben sichtbar. Eine angeforderte Überarbeitung wird mit ihrem Kommentar
angezeigt.

Die Übernahme führt keine Vorschläge aus und sendet keine alten Nachrichten an
ein Modell. Ein noch offener Vorschlag kann anschließend unter den aktuellen
Freigaben angenommen werden. Dabei werden Fachänderung und neues
Ergebnisprotokoll zusammen gespeichert; der ursprüngliche Vorschlagsdatensatz
bleibt erhalten. Bereits angenommene Vorschläge werden bei einem
Wiederholungsversuch nicht erneut ausgeführt. Das Lesen des Verlaufs bleibt
möglich, wenn lediglich der Modellanbieter nicht eingerichtet oder der
LLM-Dienst deaktiviert ist.

Geladene Chattexte und Übersichten sind an den aktuellen Inhaltszugang gebunden.
Ein Kontowechsel oder eine signierte Rechteänderung verwirft sie; verspätete
Antworten können sie nicht zurückbringen. Laufende Chat-Anfragen werden bei
einem solchen Wechsel abgebrochen. Reine Lesefreigaben erlauben weder neue
Nachrichten noch Entscheidungen über Vorschläge.

Weitere geöffnete Anmeldungen desselben Benutzers erhalten Änderungen über den
[verschlüsselten Ereignisabgleich](verschluesselte-synchronisierung.md). Der
Kanal meldet technische Speicherstände; die Webapp liest und prüft danach die
verschlüsselten Verlaufsobjekte. Andere Benutzer erhalten keine Hinweise auf
diesen persönlichen Bereich. Weitere Chat-Werkzeuge brauchen zuerst ihre
geschützten Fachadapter. Ein gespeicherter Vorschlag bleibt lesbar, wenn sein
Fachadapter nicht verfügbar ist; er erhält dadurch keine Ausführungsfreigabe.

## Noch offener Umbau

Die bisherigen Scan-Routen laden Originale in den Objektspeicher und starten
serverseitige Hintergrundjobs. Das ist kein geeigneter Transport für geschützte
Mandantendaten. Der neue Browser-Client sperrt diesen Rückfallweg. Die
Einlesen-Seite verwendet den privaten
[Browser-Adapter](../sortsys-webapp-v2/app/lib/liveLlm.ts). Auch das Übernehmen
eines Ergebnisses in einen Lieferschein oder in Preisaufzeichnungen braucht die
entsprechenden geschützten Fachadapter.

Die Bestandsumstellung archiviert alte Einleseergebnisse, Jobdaten und frühere
LLM-Nutzungsdatensätze verschlüsselt. Eine gemeinsame Sperre in PostgreSQL
wartet vorherige Master-Schreibzugriffe ab. Danach weisen API-Instanzen weitere
Aufträge für die bisherigen serverseitigen Verarbeitungspfade zurück. Neue
Job-Übernahmen sowie spätere Ergebnis- und Fehleränderungen sind gesperrt. Neue
technische Nutzungsdaten bleiben möglich; ein Providerfehler darf dabei nur als
fester Code gespeichert werden. Der Browser prüft das Archiv nach dem
Entschlüsseln erneut, auch nach einer Mandanten-Recovery.

Originale noch offener Einlesevorgänge werden ebenfalls übernommen. Bei
abgeschlossenen oder fehlgeschlagenen Vorgängen hat die bisherige Verarbeitung
ihre temporären Uploads bereits zur Löschung vorgesehen; solche Pfade sind keine
dauerhaften Dateianhänge. Eine verspätete Fehlerbereinigung darf während der
Übernahme keine offenen Originale löschen.

Vor der Aktivierung fehlen die vollständige Abstimmung mit laufenden Medien- und
Uploadvorgängen sowie die abschließende Klartextbereinigung. Das Archiv ersetzt
diese Schritte nicht.

Der Integrationstest mit einem lokalen Modell-Testdienst prüft den Transport,
Produktsuche aus dem entschlüsselnden Client, Originaldateien in mehreren
Blöcken, Abbruch bis zur HTTP-Verbindung des Providers sowie die Abweisung
falscher Signaturen und wiederverwendeter Eintrittskarten. Für Einlesen prüft er
außerdem den Ergebnisablauf mit verschlüsselter Speicherung,
Listenaktualisierung und erneutem Öffnen sowie eine fehlende Bestätigung nach
dem Speichern. Der echte XLSX-Worker wird zusätzlich im Browser geprüft. Beim
Chat kommen Annahme nach verlorener Bestätigung, gleichzeitige Änderungen,
Ablehnung, Überarbeitung und erneutes Öffnen hinzu. Der native Test zur
Chatübernahme prüft außerdem ursprüngliche Entscheidungen, konkurrierende
Annahmen, getrennte Benutzerbereiche und die erneute Freigabe eines bestehenden
Mitgliedskontos nach zwei Mandanten-Recoveries. Ein vollständiger Vergleich
aller Chat-Werkzeuge und Folgeabläufe steht noch aus.
