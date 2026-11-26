# @sortsys/v2-client

`@sortsys/v2-client` ist der TypeScript-Client für die sortsys-API. Er bündelt
Anfragen, erhält SuperJSON-kompatible Datumswerte und übernimmt
Bearer-Authentifizierung, Entdoppelung, Caching und erneutes Laden von Streams.
Zur Laufzeit besteht keine tRPC-Abhängigkeit.

## Bauen

Vor dem Build muss der erzeugte Vertrag aktuell sein:

```bash
cd sortsys-api-v2
cargo run --package sortsys-api --bin generate_contract -- --check
cd client
bun install --frozen-lockfile
bun run build
```

JavaScript, Typdeklarationen und Paketmetadaten entstehen in `dist/`.

## Verwendung

```ts
import { createClient } from "@sortsys/v2-client";

const client = createClient("/api/v2", "webapp", {
  cacheable: (path) => !path.startsWith("zerotrust."),
});

const [reply, error] = await client.query("ping", undefined);

if (error) {
  throw error;
}

console.log(reply);
```

Pfade, Eingaben und Ergebnisse von `query` und `mutate` kommen aus
`src/generated/contract.ts`. Cache-Strategien sind `network-first`, `network-only`,
`cache-first` und `cache-only`. Tokens werden als Bearer-Header angehängt;
`restoreSession()` stellt Browsersitzungen wieder her.

Der Standardcache hält API-Antworten nur im Arbeitsspeicher der Clientinstanz.
Er verwirft die am längsten nicht verwendeten Ergebnisse bei mehr als 200
Einträgen oder 8 MiB serialisierter Antworten. Nach einem Neuladen fragt der
Client die Daten erneut ab. Der Cache ändert die Sitzungsspeicherung nicht.

`network-only` teilt nur noch laufende identische Anfragen. Sobald eine Antwort
eingetroffen ist, fragt der nächste Aufruf den Server erneut. Das gilt auch,
wenn zuvor eine andere Cache-Strategie dieselbe Anfrage abgeschlossen hat.

`cacheable` nimmt ausgewählte Pfade vollständig vom Antwortcache aus. Ihre
Ergebnisse werden weder als Cache-Wert serialisiert noch später als Ersatz für
eine fehlgeschlagene Anfrage verwendet. Laufende identische Anfragen dürfen
weiterhin dieselbe Antwort teilen. Die Webapp nutzt dies für Sicherheitsmetadaten,
die ihre Zugriffsprüfungen stets frisch laden.

Der Client sammelt Lese- und Schreibanfragen getrennt über ein festes Fenster
von vier Millisekunden.
Damit können auch unabhängige Aufrufe nach asynchronen Prüfungen dieselbe
HTTP-Anfrage nutzen. Sobald 32 Operationen warten, wird der Stapel sofort
gesendet. Weitere Aufrufe verlängern das Sammelfenster nicht. So können auch
unabhängig vorbereitete Signaturen und verschlüsselte Änderungen gemeinsam
übertragen werden. Ein vor dem Versand abgebrochener Schreibaufruf wird aus
dem Stapel entfernt; die übrigen Aufrufe werden weiter gesendet. Nach dem
Versand kann eine Änderung trotz Abbruch bereits wirksam geworden sein.
Die Bündelung mehrerer Operationen stellt keine gemeinsame
Datenbanktransaktion her; atomare Änderungen verwenden die dafür vorgesehenen
API-Operationen.

Kleine Leseanfragen verwenden GET. Würde die gebündelte URL länger als 6.000
Zeichen, überträgt der Client die Eingaben als JSON-Body mit POST. Ein Stapel
enthält höchstens 32 Operationen und ein MiB Eingabedaten einschließlich
JSON-Rahmen. Maßgeblich ist die UTF-8-Bytegröße. Größere Einzeloperationen werden
allein übertragen; für sie gilt weiterhin das Limit ihres API-Endpunkts.
Reihenfolge, Datentypen und die beim Aufruf geltenden Eingaben und Zugangsdaten
bleiben erhalten. Anfragen mit verschiedenen
Zugangsdaten werden in getrennten Stapeln übertragen.

Die API weist Stapel mit mehr als 32 Operationen oder unvollständiger Zuordnung
von Pfaden und Eingaben zurück, bevor eine Operation beginnt. Mehrere Pfade
setzen eine ausdrücklich als Stapel gekennzeichnete Anfrage voraus.

Die Browser-Anmeldung verwendet den
[OPAQUE-Anmeldeweg der Webapp](../../sortsys-webapp-v2/app/lib/crypto/session.ts).
Für Geschäftsdaten ergänzt deren
[Datenfassade](../../sortsys-webapp-v2/app/lib/data/businessClient.ts) den Transport
um lokale Suche, Inhaltsprüfung und Verschlüsselung. Ein typisierter
Geschäftspfad registriert keinen Klartext-Endpunkt an der API.

## Tests

```bash
bun test
```

`scripts/test-api` im Repository prüft zusätzlich den erzeugten Vertrag und die
Client-Suite innerhalb der API-Integrationsumgebung.

## Lizenz

Für dieses Paket gilt die [GNU Affero General Public License v3.0 only](../LICENSE).
