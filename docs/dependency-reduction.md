# Abhängigkeiten reduzieren

Eine Bibliothek kann durch Plattformfunktionen oder ein eigenes Modul ersetzt
werden, wenn diese das benötigte Verhalten abdecken. Vor dem Entfernen die
Quellnutzung, den erzeugten Framework-Code sowie die npm- und
Bun-Abhängigkeitsbäume prüfen. Ein fehlender Anwendungsimport allein belegt keine
ungenutzte Abhängigkeit.

## Vorgehen

Vor einem Ersatz eine kleine typisierte Schnittstelle und das benötigte Verhalten
festlegen, anschließend Grenzfälle prüfen. Kontrollieren, ob transitive Pakete
tatsächlich verschwinden und keine neue Testabhängigkeit die Ersparnis aufhebt.
Beide Lockdateien und das Lizenzverzeichnis aktualisieren.

Rich Text, HTML-Bereinigung, Kryptografie, Kompression, komplexe Dokumentformate
und große Editoren benötigen wegen ihrer Kompatibilitäts- und Sicherheitsanforderungen
eine eigenständige Bewertung.

## Umgesetzte Änderungen

### Fehlergrenzen

`sortsys-webapp-v2/app/components/primitives/ErrorBoundary.ts` übernimmt den
React-Lebenszyklus einer Fehlergrenze: Ersatzdarstellung, Fehlerweitergabe,
gezielter erneuter Versuch und Rücksetzschlüssel, die mit `Object.is` verglichen
werden. Die Komponente enthält keine Anwendungsoberfläche, Übersetzungen, Netzaufrufe
oder Telemetrieabhängigkeiten.

`ScopedErrorBoundary.tsx` ergänzt die lokalisierte Fehleransicht und
Client-Fehlermeldung. Fachseiten verwenden diese Hülle weiter; Darstellung und
Meldung bleiben außerhalb der Basiskomponente.

Abgedeckt sind Render- und Lebenszyklusfehler untergeordneter Komponenten.
Ereignishandler, beliebige asynchrone Rückrufe und serverseitiges Rendern benötigen
eigene Fehlerbehandlung. `npm run test:error-boundary` prüft den Lebenszyklus mit
einer simulierten React-Zustandsverwaltung. Die Integration mit einem DOM-Renderer
ist nicht Teil dieser Tests.
Die Tests laufen mit Typprüfung und Produktionsbuild in der CI.

### Build-Konfiguration

Vite 8 löst TypeScript-Pfade mit `resolve.tsconfigPaths: true` auf. Das Plugin
`vite-tsconfig-paths` ist entfernt; Browser- und lokale Paketaliase bleiben in
`vite.config.ts` ausdrücklich definiert.

`isbot` bleibt eine direkte Abhängigkeit: Der erzeugte React-Router-Servereinstieg benötigt
es, und das Werkzeug installiert es bei Fehlen selbst in dieser SPA-Konfiguration.

### API-Client

Das veröffentlichte `@sortsys/v2-client` benötigt `rxjs` und `superjson`.
Das ungenutzte `@types/send` ist entfernt. `@types/node` bleibt für Build-Skripte
und Tests eine Entwicklungsabhängigkeit; öffentliche Deklarationen verlangen
keine globalen Node- oder Bun-Typen.

Nach dem Client-Build prüft `test:local-package-locks` die veröffentlichten
Abhängigkeiten und ein Testprojekt mit `types: []` sowie `skipLibCheck: false`.
Zudem werden npm-/Bun-Metadaten für Client, DWG-Viewer und React-Komponenten mit
ihren Quellmanifesten verglichen.

Die öffentliche Observable-Schnittstelle verwendet RxJS. SuperJSON erhält
Datumswerte, große Ganzzahlen und `undefined` im RPC-Protokoll. Ihr Ersatz benötigt
eine gesonderte Kompatibilitätsprüfung.

### Rust-API

`sortsys-api-v2/rust-api/src/hex_encoding.rs` erzeugt mit der Standardbibliothek
kleingeschriebene Hexadezimaldarstellungen. Führende Nullen bleiben erhalten;
`AsRef<[u8]>` akzeptiert Byteausschnitte, Arrays und Hash-Puffer. Hashes, HMAC,
Verschlüsselung und Zufallsquellen der Aufrufer bleiben bestehen.

`hex` ist keine direkte Abhängigkeit mehr, wird aber weiterhin transitiv von SQLx
benötigt. Die Zahl aufgelöster Cargo-Pakete sinkt dadurch nicht. Tests vergleichen
leere Eingaben, typische Bytes und alle Bytewerte mit der Standardformatierung.
Der konstante AES-GCM-Testvektor ist als Bytefolge hinterlegt.

### DWG-Viewer

Bei der Ablösung von Vitest wurden die 31 bestehenden Prüfungen auf `node:test` und
`node:assert/strict` unter Node 24 umgestellt. Native TypeScript-Verarbeitung ersetzt
den Test-Transpiler. Mit der Entfernung von `vitest` schrumpfte die eigene npm-Lockdatei
von 103 auf 43 Einträge einschließlich Paketwurzel und optionaler Plattformpakete;
andere Paketversionen dieser Lockdatei ändern sich nicht.

`viewportInteractionTransform` liegt als reine Funktion in `src/core/cadViewport.ts`.
`PlanViewer.tsx` verwendet sie und erhält den bisherigen benannten Export.
Geometrie, Darstellungsmodell, Normalisierung und Szenenadapter bleiben geprüft;
der Browser-Renderer selbst ist nicht Teil dieser Tests.

`src/assets.d.ts` beschreibt WASM-URLs und eingebettete Worker-Konstruktoren.
Der Viewer benötigt dadurch keine globalen Vite-Clienttypen. Die Webapp bündelt
ihn weiterhin mit Vite.

Die erneuerten lokalen Paketmetadaten korrigieren auch alte Node-22-/25-Einträge
und fehlende TypeScript-7-Deklarationen im Bun-Lock der Webapp. Gegenüber dem Stand
vor der Umstellung entfallen vier Einträge und kommen 23 hinzu: 20 optionale
TypeScript-7-Plattformpakete, der lokale Viewer-TypeScript-Eintrag und zwei
React-Typeinträge. Der Zuwachs um 19 dokumentiert bereits erklärte Abhängigkeiten.

### Weitere Komponenten

Die React-Komponenten deklarieren nur React und React DOM als Peer-Abhängigkeiten.
Die Lockdatei-Prüfung erfasst ihre lokalen Metadaten; zusätzliche Hilfsbibliotheken
werden nicht eingeführt.

Der Rust-DWG-Parser behält Serde und Serde JSON für Szenen und Worker-Schnittstelle.
Der Go-Hintergrunddienst verwendet Gorilla WebSocket für den Transport, nativewebp
für WebP und `golang.org/x/image/draw` für Catmull–Rom-Skalierung. Ein Ersatz
verlangt passende Transport-, Format- oder Bildqualitätstests.

Build und Wartung verwenden die vorhandenen Node-, Python-, Shell- und
Sprachwerkzeuge. Es wird keine Ersatz-Testbibliothek eingeführt.
