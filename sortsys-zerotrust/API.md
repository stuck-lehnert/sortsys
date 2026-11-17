# Einbindung des Frameworks

## Browser: Inhalte und Rechte

In einem anderen Monorepo kann die TypeScript-Abhängigkeit etwa als
`"@sortsys/zerotrust": "file:../sortsys-zerotrust"` eingetragen werden. Der
Einstieg enthält keine sortsys-Fachmodelle. Jede Framework-Instanz erhält eine
unveränderliche Kopie ihrer erlaubten Inhaltsbereiche; es gibt keine globale
Konfiguration.

Das folgende Beispiel verschlüsselt eine Notiz. In einer Anwendung werden die
Identität und der Bereichsschlüssel beim Anmelden beziehungsweise aus einem
verifizierten Schlüsselpaket geladen. Sie dürfen nicht bei jedem Schreibzugriff
neu erzeugt werden.

```ts
import {
  areaKey,
  bytes,
  createIdentity,
  createZeroTrust,
  type ObjectContext,
} from "@sortsys/zerotrust";

const security = createZeroTrust({ facets: ["notes", "appointments"] });
const identity = await createIdentity();
const key = await areaKey();
const context: ObjectContext<"notes"> = {
  tenant: "practice:alpha",
  scope: "patient:ada",
  facet: "notes",
  object: "note:1",
  revision: "1",
  generation: "1",
  policyVersion: "1",
  author: "doctor:lee",
};
const encrypted = await security.objects.encryptObject(
  context,
  bytes("Vertrauliche Notiz"),
  key,
  identity.signingKey.privateKey,
);
const plaintext = await security.objects.decryptObject(
  encrypted,
  context,
  key,
  identity.signingKey.publicKey,
);
```

`context` muss aus dem erwarteten Zugriff stammen. Ein Kontext, der unverändert
aus einer fremden Antwort übernommen wird, schützt nicht vor der Vertauschung
von Mandant, Objekt oder Autor. Bei Fehlern liefern die Prüffunktionen
`InvalidProtectedData`.

`security.policies.signPolicy` signiert Rechte. `verifyPolicy` prüft sie gegen
einen bereits vertrauten Autoritätsschlüssel und den erwarteten Mandanten.
Erst anschließend werten `compilePolicy` und `compileReadership` die Regeln aus.
Ein ausdrückliches Verbot gewinnt; gesperrte Konten erhalten keine Rechte.
Untergruppen und Rollen müssen durch signierte Regeln abgebildet werden.
Aus ähnlich benannten Bereichen leitet der Kern keine Rechte ab.

`signPolicyTransaction` verbindet eine Rechteänderung mit den verschlüsselten
Paketen und den Ausgangsversionen, auf denen sie beruht. Für bis zu 64 Pakete
enthält der Nachweis deren Signaturen. Bei größeren Mengen speichert er deren
Anzahl und den SHA-256-Nachweis der vollständigen, sortierten Signaturliste.
Dadurch wächst die gespeicherte Rechteregel nicht mit jeder einzelnen Änderung.
Der Server muss den Nachweis beim gemeinsamen Commit mit allen tatsächlich
vorgelegten Paketen vergleichen; dafür dient in Rust
`PolicyTransaction::binds_packets`. Eine gültige Autoritätssignatur allein
ersetzt diesen Vergleich nicht.

Anwendungsspezifische Regelherkünfte können über `policy.validateRuleOrigin`
geprüft werden. Ohne diese Erweiterung werden Regeln mit `origin` abgelehnt.
`policy.validateSuspendedSubject` erlaubt zusätzliche Beschränkungen des
Benutzerkennungsformats. Dieselben fachlichen Beschränkungen müssen auch auf
der Serverseite gelten.

## Rechteverwaltung delegieren

Ein primär mit `signPolicy` signierter Stand kann einem zertifizierten Verwalter
`grant` für einen bestimmten Bereich und Inhaltsbereich erlauben. Dieser
Verwalter signiert Änderungen mit seinem eigenen Identitätsschlüssel. Der
private Autoritätsschlüssel wird dafür nicht weitergegeben.

Für die erste Änderung auf einem bereits geprüften primären Stand:

```ts
const version = (BigInt(checkpoint.version) + 1n).toString();
const profile = await security.policies.administrativeProfiles.sign(
  {
    tenant: checkpoint.tenant,
    rootSignature: checkpoint.signature,
    version,
    subject: "doctor:ada",
    scope: "patient:ada",
    facet: "notes",
    actions: ["read", "update"],
    author: managerCertificate,
  },
  managerIdentity.signingKey.privateKey,
);
const next = await security.policies.signAdministrativePolicy(
  {
    root: checkpoint,
    profiles: [profile],
    author: managerCertificate,
    previousSignature: checkpoint.signature,
    version,
  },
  managerIdentity.signingKey.privateKey,
);
```

Ein Profil ersetzt die gewöhnlichen Rechte genau eines Empfängers in einem
Bereich. Es darf nur Aktionen enthalten, die der Verwalter selbst besitzt;
`grant` lässt sich damit nicht weiterreichen. Für Nutzer, die im selben Bereich
selbst ein Verwaltungsrecht haben, bleibt die primäre Autorität zuständig.
Eigene Verwaltungsrechte für persönliche Einstellungen schützen keine anderen
Bereiche vor solchen Änderungen.

`verifyPolicy` prüft den primären Stand, Zertifikate, Profile, abgeleitete Regeln
und die äußere Signatur. Historische Nachweise bleiben dabei prüfbar. Vor dem
Speichern sind zusätzlich **beide Stände** zu verifizieren und
`administrativeReplacement(previous, next, currentActorCertificate)` zu prüfen.
Diese Prüfung bindet die Änderung an den aktuellen Vorgänger, dessen primären
Stand und den tatsächlichen Absender. Sie verhindert auch das Entfernen oder
Wiedereinspielen fremder Profile. Mindestens ein Profil muss sich ändern;
eine bloße neue Versionsnummer genügt nicht. Unveränderte Profile werden nach
`administrativeProfileKey` sortiert übernommen.

Die Anwendung muss diese Vergleiche zusammen mit der aktiven Sitzung und dem
aktuellen Empfängerzertifikat in derselben Transaktion ausführen. In Rust dienen
dafür `PolicyRef::verify` und `PolicyAdministrationRef::replaces`. Eine neue
primäre Signatur kann die effektiven Mitarbeiterrechte übernehmen und zugleich
ein Verwaltungsrecht entfernen. Sie ersetzt dann die Profile; es entsteht keine
wachsende Kette früherer Berechtigungsstände.

Die Rechteprüfung verteilt noch keine Inhaltsschlüssel. Neue Leser und ein
kryptografischer Leserentzug benötigen zusätzlich geprüfte Schlüsselpakete und
gegebenenfalls einen Schlüsselwechsel durch den Speicheradapter.

### Schlüsselverwaltung im selben Bereich

`security.keyAuthorities.certify(input, authorityKey)` bestätigt den öffentlichen
Identitätsschlüssel eines Verwalters für genau einen Bereich und Inhaltsbereich.
Der Nachweis enthält `tenant`, `generation`, `scope`, `facet` und `holder`.
`holder` ist das bereits bestätigte Identitätszertifikat des Verwalters. Der
private Mandantenschlüssel bleibt bei der primären Autorität.

Der Verwalter erzeugt anschließend mit `security.domains.createManagedDomain`
eine neue Bereichsgeneration. Er übergibt den Nachweis als `keyAuthority`, seinen
eigenen privaten `signingKey`, die zertifizierten Leser und die öffentlichen
Recovery-Schlüssel. `rewrapDomainKey` verteilt vorhandene Bereichsschlüssel neu;
es öffnet die eigene Schlüsselkopie und verschlüsselt sie für die ausgewählten
Leser. Historische Kopien anderer Verwalter benötigen deren Nachweis als
`sourceAuthority`. Der entschlüsselte Schlüssel wird nicht zurückgegeben.

`verifyKeyAuthority` beziehungsweise `security.keyAuthorities.verify` prüft den
erwarteten Kontext und die Signaturen. Rust bietet dieselbe Prüfung mit
`key_authorities::KeyAuthority` und `KeyAuthorityContext`; `domains::DomainFrameRef`
bildet den zugehörigen Bereichsnachweis. Der Speicheradapter muss bei jeder neuen
Veröffentlichung zusätzlich die tatsächliche Sitzung, das aktuelle
Identitätszertifikat sowie `grant` und `read` im betroffenen Bereich prüfen.
Ein historisch gültiger Nachweis erlaubt nach dem Entzug keine neuen
Schlüsselpakete. Die Browserprüfung muss außerdem das Verwaltungsrecht zum
signierten `policyVersion` der Bereichsdefinition nachweisen.

Die Recovery sammelt fremd signierte Bereichsdefinitionen in
`RecoverySource.delegatedDomains`. Jede Definition muss zur exakten
Schlüsselgeneration und Recovery-Hülle gehören. Damit lassen sich solche
Schlüssel allein mit der Recovery-Phrase prüfen und öffnen; ein Benutzerkonto
oder ein privater Verwalterschlüssel wird dafür nicht benötigt.

## Begrenzte Anlegedelegationen

`createDelegationCodec(["patient-file", "appointment"])` prüft und signiert
Delegationen für anwendungseigene Ressourcenarten. Ein Zertifikat benennt den
Ersteller und ein bis acht verpflichtende Empfänger. Alle Identitätszertifikate
müssen zum Mandanten und zur Autoritätsgeneration der Delegation gehören. Das
Zertifikat enthält öffentliche Schlüssel und Signaturen; der private
Autoritätsschlüssel bleibt bei der ausstellenden Stelle.

`certify(input, authorityKey)` erzeugt den Nachweis. Zum Prüfen dient
`verify(input, { tenant, generation, namespace, creator }, authorityKey)`.
Der erwartete Kontext muss aus der geprüften Sitzung und dem beabsichtigten
Vorgang stammen. Eine gültige Signatur allein erlaubt weder das Verteilen an
weitere Empfänger noch das Ändern bestehender Ressourcen.

Rust bietet dieselben Prüfungen mit `delegations::DelegationCertificate` und
`DelegationContext`. Ein eigener Namespace-Enum kann beim Deserialisieren
unbekannte Ressourcenarten ausschließen. `DelegationRef` bindet vorhandene
Anwendungsstrukturen an denselben Prüfer, ohne Zertifikate zu kopieren. Die
sortsys-API verwendet diesen Weg für Projekt-, Vorgangs- und Werkzeuganlagen.

Die Anwendung muss den aktuellen Delegationsstand, das Anlegerecht und die
Bindung an die neue Ressource in der Veröffentlichungstransaktion prüfen.
Widerrufe, verbrauchte Einmalberechtigungen und Berechtigungen weiterer
Empfänger sind damit noch nicht aus einem Signaturnachweis ableitbar.

## Veränderliche Zugriffsstände

`signResourceAccess(input, key)` bindet einen öffentlichen Zugriffsstand an die
Signatur einer bestimmten Chiffratrevision. Der Nachweis enthält Mandant,
Ressource, Objekt, Revision, Autoritätsgeneration, eine anwendungseigene
32-Byte-Bindung und `active`. Der Autor wird durch sein Identitätszertifikat
nachgewiesen. Geschäftstexte und Schlüssel gehören nicht in diese Struktur.

`verifyResourceAccess(input, expected, authority)` prüft Form, erwarteten Kontext,
Zertifikat und Signatur. Rust bietet denselben Rahmen und dieselbe Prüfung als
`resource_access::ResourceAccessState`. Die Anwendung muss den vertrauenswürdigen
Kontext vorgeben. Die Bibliothek entscheidet weder über Schreibrechte des Autors
noch über erlaubte Zustandsübergänge.

Beim Speichern muss die Anwendung den Nachweis und das genaue Chiffrat in
derselben versionsgeprüften Transaktion veröffentlichen. Sie prüft auch die
aktuelle Sitzung, Schreibrechte, Paketrevision und Paketsignatur. Soll ein
beendeter Zugriff nicht wieder aufleben dürfen, muss sie diesen Übergang
ausdrücklich ausschließen. Ohne aktuellen Nachweis dürfen daraus keine Rechte
entstehen. Empfängerschlüssel müssen bei einem Entzug für spätere Inhalte
gewechselt werden; die Signatur allein macht frühere Schlüssel nicht unbrauchbar.

Der Browser muss nach dem Entschlüsseln außerdem prüfen, ob der öffentliche
Zugriffsstand zum Fachinhalt passt. Ein berechtigter, aber manipulierter Client
kann beides widersprüchlich signieren. Ohne Klartext oder zusätzliche Beweise
kann der Server diese fachliche Konsistenz nicht garantieren.

## Wiederholte öffentliche Nachweise

Zertifikate, Rechteregeln und Schlüsselumschläge enthalten öffentliche Metadaten
beziehungsweise verschlüsselte Schlüssel. Der Kern verwendet dafür
`verifyPublicProof`: Identische Signaturprüfungen teilen sich einen auf 4.096
Einträge begrenzten Speicher. Jeder Eintrag bindet den tatsächlichen
Prüfschlüssel, die Signatur und den SHA-256-Wert der vollständigen signierten
Bytes. Ungültige Nachweise werden nicht gespeichert. Große Nachrichten werden
weiterhin direkt von WebCrypto geprüft.

Das ersetzt keine Kontextprüfung. Mandant, Generation, aktuelle Rechte und
Widerrufe müssen auch bei einer bereits bekannten Signatur geprüft werden.
Für entschlüsselte Geschäftsinhalte bleibt `verify` zuständig; deren Signaturen
und Inhaltsprüfsummen gehören nicht in diesen öffentlichen Speicher.
`createPublicProofVerifier({ capacity })` erstellt einen eigenen Prüfer mit
`verify` und `clear`; mit `capacity: 0` ist die Wiederverwendung ausgeschaltet.
`publicProofDigest` erzeugt dieselben SHA-256-Werte wie `digest` und vermeidet
bei kleinen öffentlichen Rahmen zusätzliche WebCrypto-Aufrufe.

## Lokale Inhaltsprüfung

`VerifiedStore<T>` verbindet einen Inhaltsbereich mit einem anwendungseigenen
`schema.decode`. Auch ein korrekt signierter Inhalt muss dieses Schema bestehen.
Bei einer fehlerhaften Änderung bleibt der letzte geprüfte Wert verfügbar;
ältere Revisionen und widersprüchliche Signaturen ersetzen ihn nicht.
`lock()` verwirft den gehaltenen Klartext und verhindert, dass eine bereits
laufende Entschlüsselung ihn nachträglich wieder einträgt.

Eine gültige Signatur beweist die Urheberschaft, nicht die fachliche Richtigkeit.
Der Speicheradapter muss deshalb auch bei gültigen Signaturen mit Inhalten
rechnen, die andere Clients nach dem Entschlüsseln ablehnen. Der Server kann
verdeckte Feldwerte und Beziehungen nicht auf ihre fachliche Konsistenz prüfen.

## Rust: öffentliche Nachweise prüfen

Die Crate lässt sich ohne sortsys-API verwenden:

```toml
[dependencies]
sortsys-zerotrust = { path = "../sortsys-zerotrust" }
```

`protocol::EncryptedObject<String>` unterstützt eigene Inhaltsbereiche. Bei
`EncryptedObject<F>` kann eine Anwendung stattdessen einen eigenen Enum-Typ mit
`AsRef<str>` verwenden und damit unbekannte Bereiche schon beim Deserialisieren
abweisen. `verify` prüft Signatur und öffentliches Format:

```rust,ignore
use sortsys_zerotrust::{protocol::EncryptedObject, Result};

fn check_object(object: &EncryptedObject, trusted_signer: &[u8; 32]) -> Result<()> {
    object.verify(trusted_signer)
}
```

`policy::PolicyRef` und `RuleRef` arbeiten auf geliehenen Daten. Ihre Felder
enthalten frei wählbare Bereichs- und Benutzerkennungen; `frame` erzeugt dieselben
Signaturbytes wie der Browser. `verify` prüft den Nachweis. `allows_with` wertet
bereits geprüfte Regeln aus. Zusätzlich übergebene Regeln benötigen einen eigenen
geprüften Herkunftsnachweis.

`protocol` enthält außerdem Autoritäts- und Identitätszertifikate sowie
HPKE-Schlüsselpakete. `AccountVault` prüft das öffentliche Format eines
verschlüsselten Kontospeichers. Das optionale Cargo-Feature `typescript` ergänzt
`ts-rs`-Typen für eine API-Vertragsgenerierung.

## Unveränderliche Datensätze

`immutableObject(scope, facet, kind, id)` bildet einen Objektnamen für dauerhaft
festgeschriebene Inhalte. `immutableRecord` prüft seine Bindung an den Bereich;
`immutableWriteAction` erlaubt ausschließlich die erste Revision eines normalen
Objekts. Spätere Revisionen und Löschmarkierungen werden abgelehnt. Beide
Funktionen unterstützen frei gewählte Inhaltsbereiche.

Rust bietet dieselben Regeln als `immutable::binding` und
`immutable::write_action`. Sie werden nach der Signaturprüfung ausgewertet.
Der Speicheradapter prüft zusätzlich Schreibrechte und die Abwesenheit einer
bisherigen Revision innerhalb derselben Transaktion. Ein optionaler
OpenTimestamps-Nachweis kann ergänzt werden; sein Ausfall oder Entfernen hebt
diese Schreibsperre nicht auf.

## Passkeys ohne Übertragung des Entschlüsselungsschlüssels

`createPasskeyCredential` und `getPasskeyCredential` verwenden die WebAuthn-API
des Browsers. Sie nehmen Optionen mit Base64url-kodierten Challenges und
Kennungen entgegen und liefern `{ credential, unlock }`. Nur `credential` gehört
in eine Serveranfrage. Der separate `PasskeyUnlock` hält das lokale Ergebnis der
PRF-Erweiterung und lässt sich nicht als JSON serialisieren.

Nach erfolgreicher Registrierung bindet
`unlock.createVault(accountDataKey, accountVault)` den bestehenden
Kontodatenschlüssel an diesen Passkey. Der Server speichert das signierte
Schlüsselpaket. Rusts `passkey::PasskeyVault::verify_binding` prüft dabei das
gespeicherte Konto sowie die RP- und Credential-Kennung aus der bereits
verifizierten WebAuthn-Registrierung. Diese Prüfung ersetzt nicht die Prüfung
der WebAuthn-Signatur, der Herkunft, der Benutzerbestätigung oder der Challenge.

Bei der Anmeldung öffnet
`unlock.openVault({ tenant, username }, keyVault, accountVault)` denselben
Kontospeicher. Ein Passwortwechsel kann den Kontodatenschlüssel behalten;
dadurch bleiben die dafür eingerichteten Passkeys verwendbar. Jeder Aufrufer
muss `unlock.dispose()` in einem `finally`-Block ausführen. Ein `AbortSignal`
bricht einen noch offenen Browserdialog ab. Die Anwendung muss außerdem
verhindern, dass eine verspätete Antwort eine neuere Sitzung ersetzt.

Nicht jeder Authenticator unterstützt PRF. Dann ist `unlock` gleich `null`;
WebAuthn kann weiterhin anmelden, liefert aber keinen Entschlüsselungsschlüssel.
Die Anwendung benötigt dafür einen bereits geschützten Gerätespeicher oder die
gewöhnliche Passwortanmeldung. Authenticatoren, die PRF erst bei einer Assertion
auswerten, werden bei der Registrierung durch eine zusätzliche lokale Abfrage
unterstützt. Deren Ergebnis wird ebenfalls nicht an den Server übertragen.

Der Speicheradapter muss jede Challenge genau einmal und in derselben
Transaktion wie Registrierung beziehungsweise Sitzungserstellung verbrauchen.
Diese Information muss allen API-Instanzen zur Verfügung stehen. Ein
Signaturzähler allein genügt dafür nicht: Synchronisierte Passkeys können
dauerhaft den Zählerstand null liefern. Die lokale PRF-Auswertung verhindert
weder Challenge-Replays noch Fehler in der serverseitigen WebAuthn-Prüfung.

## Recovery und Speicherung

Der Browser erzeugt eine 24-Wort-Phrase mit `createRecoveryPhrase`.
`recoveryIdentity` leitet daraus mandanten- und generationsgebundene Schlüssel
ab. `recoveryTransitionFrame` und Rusts `recovery::RecoveryTransition` binden
den Wechsel an die bisherige Autorität, eine Challenge und den neuen
Administrator samt neuem Schlüsselbestand.

`security.setup.createTenantSetup` erstellt die anfängliche Autorität, das
Eigentümerzertifikat und den verschlüsselten Recovery-Katalog.
`ownerRegistrationFrame` bindet den Besitznachweis des ersten Kontos an Mandant,
Kontokennung, Nutzername, Registrierungsablauf, OPAQUE-Datensatz, verschlüsselten
Kontospeicher und anfänglichen Schlüsselzustand. Rust stellt denselben Rahmen als
`initialization::OwnerRegistration::frame` bereit. Der Speicheradapter muss die
einmalige Einrichtungsberechtigung zusammen mit Konto und Schlüsselzustand
verbrauchen; der Signaturnachweis ersetzt diesen atomaren Schritt nicht.

`security.domains.createDomain` verteilt einen Bereichsschlüssel an die
festgelegten Leser und den Recovery-Schlüssel. Delegiertes Anlegen benötigt
einen ausdrücklich angebundenen `domainCreation`-Prüfer. Ohne ihn werden
fremde Herkunftsnachweise abgelehnt.

`security.domains.rewrapDomainKey` verteilt einen bereits bestehenden
Bereichsschlüssel an zusätzliche Empfänger. Die Anwendung übergibt die erwartete
Bereichskennung, die signierte Definition, das eigene Schlüsselpaket und die aus
geprüften Regeln und Zertifikaten abgeleiteten Leser. Die Funktion prüft
Definition und Paket, öffnet den Schlüssel im Browser und liefert neue
HPKE-Schlüsselhüllen zurück. Ein Klartextschlüssel gehört nicht zum Ergebnis;
der eigene temporäre Schlüsselpuffer wird auch bei Fehlern überschrieben.
`signal` und der optionale `live`-Callback brechen den Vorgang ab, wenn das
zugehörige Konto währenddessen gesperrt oder gewechselt wird. Der Callback muss
diese Kontobindung prüfen; das Framework kennt weder Anmeldeoberfläche noch
Anwendungskonten.

Das Speichern der Hüllen bleibt Aufgabe des Adapters. Ein Adapter muss dabei
aktuelle Rechte und die erwartete Regelversion nochmals in der schreibenden
Transaktion prüfen. Bereitet der Browser mehrere Hüllen vor, erteilt deren
Signatur allein keine Freigabe gegen eine inzwischen geänderte Richtlinie.

`security.recovery.prepareRecovery` übernimmt den vollständigen veröffentlichten
Schlüsselbestand, die bisherige und die neue Phrase sowie das neue Passwort.
Die Funktion prüft den bisherigen Vertrauensanker, erhält historische Schlüssel
und erzeugt neue Schlüssel für künftige Änderungen. Über den `register`-Callback
werden ausschließlich eine OPAQUE-Registrierungsnachricht und ihr öffentlicher
Signaturnachweis übertragen. Die Phrase, das Passwort und entschlüsselte
Bereichsschlüssel bleiben im Browser. Für eigene Kontokennungen kann
`recovery.createAdministrator` beim Einrichten des Frameworks vorgegeben werden.
Die Passwortableitung kann über `registrationCrypto` in einen Worker verlegt werden.

Ein Speicheradapter muss den Wechsel nach Prüfung der alten und neuen
Nachweise atomar übernehmen. Die verbrauchte Generation und Challenge dürfen
nicht erneut verwendet werden. Ein zweiter Aufruf darf nur denselben bereits
vorbereiteten Wechsel fertigstellen. Transaktionen, Sperren und Versionsvergleiche
gehören zum Adapter; sie lassen sich durch die Signaturprüfung allein nicht ersetzen.
Diese Vorbereitung gehört zum allgemeinen Kern und unterstützt wiederholte
Wiederherstellungen. Der Anwendungseinstieg ergänzt dafür seine fachlichen
Herkunftsprüfungen; die Übernahme in den dauerhaften Speicher bleibt beim Adapter.

Auch normale Schreibzugriffe benötigen einen Versionsvergleich innerhalb der
Speichertransaktion. Die Anwendung prüft erwarteten Mandanten, Sitzung,
Berechtigungsstand, Autor und aktuelle Schlüsselgeneration. Die Bibliothek
speichert keine privaten Schlüssel und richtet keine Datenbanktabellen ein.

## Bestände seitenweise lesen

`readSnapshotPages` liefert einen asynchronen Iterator über Seiten mit
`{ snapshot, items, after }`. `collectSnapshotPages` sammelt dieselben Seiten in
einem Array. Der Speicheradapter erhält bei jedem Aufruf den bisherigen
Snapshot und Cursor; `maxItems` legt die vereinbarte Seitengröße fest.

Der Leser verwirft wechselnde Snapshots, zu große Seiten und wiederholte
Fortsetzungscursor. Leere Seiten mit einem neuen Cursor sind zulässig, etwa
wenn unveröffentlichte Schlüssel herausgefiltert wurden. Ein `AbortSignal`
verhindert auch, dass eine verspätete Antwort noch ausgegeben wird. Es gibt kein
Vorabladen; beim Verlassen des Iterators werden keine weiteren Seiten angefragt.

Rusts `pagination::SnapshotPage::from_lookahead` übernimmt höchstens eine
zusätzliche Zeile aus der Datenbankabfrage. Ihr Vorhandensein erzeugt einen
Fortsetzungscursor für die letzte tatsächlich ausgelieferte Zeile. Der zusätzliche
Datensatz wird erst auf der nächsten Seite ausgegeben.

Die Seitenstruktur ist kein Echtheitsnachweis. Signaturen, erwarteter Mandant,
Berechtigungen und Inhaltsschema müssen weiterhin geprüft werden. Für den
Recovery-Katalog verbindet `security.recovery.loadRecoverySource` die Seiten mit
dem zuvor gelesenen Kopf. `recoveryPageFrame` beziehungsweise Rusts
`recovery::RecoveryPageAccess::frame` binden eine Anfrage an Mandant, Generation,
Challenge, Snapshot und Cursor. Der Transport-Callback erhält keine Seed-Phrase.

Der bestehende Recovery-Plan und sein verschlüsseltes Schlüsselarchiv haben
weiterhin Grenzen von 2.000 Bereichen und 10.000 Schlüsselständen. Weder die
Seitenlesung noch eine aufgeteilte Planübertragung hebt diese Grenzen auf. Die
vollständige Vorbereitung und Veröffentlichung muss den gesamten Bestand
prüfen; unvollständige Bestände werden abgelehnt.

## Größere signierte Pakete übertragen

`preparePayload(text, { context, operation })` zerlegt einen bereits erzeugten
Text in UTF-8-Teile von höchstens 128 KiB. Das Ergebnis enthält die Teile und
ein Manifest mit ihrer Reihenfolge, ihren SHA-256-Prüfsummen, der Gesamtgröße
und der Prüfsumme des vollständigen Texts. Ein Transfer darf höchstens 512
Teile und 64 MiB umfassen. Identische Teile dürfen mehrfach vorkommen; ihre
Reihenfolge und Anzahl bleiben im Manifest erhalten.

`assemblePayload(manifest, parts)` prüft dieselben Grenzen und rekonstruiert
erst nach Prüfung aller Teile den Text. Rust verwendet dafür
`prepared_payload::PreparedPayloadManifest::assemble`. Die Anwendung bleibt für
die Berechtigung zur Übertragung und die Signaturen des zusammengesetzten
Pakets zuständig. Eine Prüfsumme allein belegt keinen berechtigten Absender.

Sortsys verwendet diesen Transport für Recovery-Pläne. Jede Übertragung ist
durch den alten Seed-Nachweis an eine kurzlebige Challenge und genau einen
Wiederherstellungsvorgang gebunden. Teile können über verschiedene
API-Instanzen gespeichert und wiederholt werden. Eine Challenge legt dabei
genau ein Manifest fest; ein zweiter Vorgang benötigt eine neue Challenge.
Die Teile verändern noch keine
Konten oder Schlüssel. Erst der vollständige Plan mit beiden Seed-Nachweisen
wird atomar veröffentlicht; anschließend prüft der Browser die erwartete neue
Autorität erneut. Die temporären Teile laufen mit der Challenge ab.

## Nachweise für übernommene Dateien

`migrationFileReceiptFrame` und Rusts `migration::MigrationFileReceipt::frame`
erzeugen dieselben Signaturbytes. Ein Nachweis bindet den Mandanten, die
Migration, die Kennung der Quelldatei, ihre Byteanzahl sowie Revision und
Paket-Hash des verschlüsselten Manifests. Hinzu kommen die Kennungen und
Paket-Hashes der Dateiblöcke in ihrer ursprünglichen Reihenfolge. Dateinamen,
Speicherpfade und Klartext-Hashes gehören nicht in diesen öffentlichen Nachweis.

Der Browser öffnet die gespeicherten Blöcke und vergleicht sie mit dem Original,
bevor er den Nachweis signiert. Der Speicheradapter prüft die Signatur und die
dauerhaft gespeicherten Paket-Hashes. Er kann die Gleichheit mit dem Original
nicht selbst prüfen. Bei einer Wiederaufnahme wird derselbe bestätigte
Dateistand verwendet; eine Recovery darf ihn nicht durch neu verschlüsselte
Blöcke ersetzen. Historische Schlüssel und Unterzeichner müssen deshalb auch
nach einem Autoritätswechsel überprüfbar bleiben.

Die Bibliothek legt weder Blockgröße noch Speicherort fest. Eine Anwendung muss
die erwarteten Datei- und Blockkennungen prüfen, den Nachweis atomar und
unveränderlich speichern und vor einer Bereinigung alle Originale erfassen.
Ein Nachweis für eine einzelne Datei bestätigt keine vollständige Migration.

## OpenTimestamps

OpenTimestamps gehört zum Framework. Der Browser kann mit `stampOtsDigest` einen
SHA-256-Digest abstempeln, mit `upgradeOtsProof` spätere Nachweise ergänzen und
mit `verifyOtsBitcoin` gegen die angebundene Bitcoin-Blockquelle prüfen. An die
Kalender geht ein zusätzlich mit Zufallsdaten gebundener Hash; die Funktion
überträgt keine Dokumentinhalte. Netzwerkzugriff und Abbruchsignal sind austauschbar.

Rusts `opentimestamps::inspect` prüft Größenlimits, kanonische Kodierung und die
Bindung an den erwarteten Digest. `ProofSummary.has_pending_attestations` meldet
noch offene Kalendernachweise. Diese Strukturprüfung bestätigt keinen
Bitcoin-Zeitpunkt. Eine Anwendung muss diesen Unterschied in ihrem Status erhalten.

Unveränderbarkeit wird unabhängig vom Zeitstempel durch signierte Dokumentstände,
Löschmarkierungen und die Schreibregeln des Speicheradapters durchgesetzt. Ein
fehlender OTS-Nachweis darf weder einen abgeschlossenen Datensatz entsperren noch
eine Wiederherstellung ohne Seed autorisieren. Ein vorhandener Nachweis ist nur
zusätzliche Evidenz; bei Ausfall der Kalender kann die Anwendung weiterarbeiten.

## Eine Bestandsübernahme bestätigen

`MigrationInventory` berechnet mit konstantem Speicherbedarf einen Hash über
öffentlich prüfbare Verweise. Einträge müssen nach `kind` und `id` aufsteigend
geordnet sein; doppelte oder vertauschte Einträge werden abgewiesen. Zulässig sind
ASCII-Bezeichner, dezimale Revisionen und Hashes von Chiffraten oder signierten
Belegen. Geschäftswerte gehören nicht in dieses Verzeichnis.

```ts
import { MigrationInventory, migrationSealFrame, sign } from "@sortsys/zerotrust";

const inventory = new MigrationInventory();
for (const reference of verifiedReferences) inventory.add(reference);
const target = inventory.finish();
const unsigned = {
  tenant, migration, schema, generation, policyVersion, catalogVersion,
  source: verifiedSourceInventory, target, author,
};
const seal = { ...unsigned, proof: await sign(signingKey, migrationSealFrame(unsigned)) };
```

Rust bietet `migration::MigrationInventory` und `migration::MigrationSeal` mit
demselben Format. `seal.verify(&signing_key)` prüft den Nachweis. Die Anwendung
muss dessen Mandant, Schema und Verzeichnisse mit ihren erwarteten Ständen
vergleichen und Änderungen zwischen Prüfung und Abschluss verhindern.

Ein solcher Nachweis bestätigt die Erklärung des unterzeichnenden Clients. Er
liefert dem Server keine fachliche Prüfung verborgener Inhalte und führt selbst
keine Löschung aus. Datenbanktransaktionen, Dateibereinigung und die Entscheidung,
wann eine Anwendung aktiviert wird, bleiben Aufgaben des jeweiligen Projekts.
Die [sortsys-Bestandsumstellung](../docs/bestandsumstellung.md) verwendet diese
Prüfbausteine für einen fortsetzbaren Abschluss.

## Öffentliche Metadaten atomar ändern

Das Modul `metadata` beschreibt denselben Speichervertrag in Rust und TypeScript.
Es enthält weder einen Datenbanktreiber noch sortsys-Fachmodelle. Ein
`MetadataBatch` nennt für jeden geänderten Datensatz die erwartete Version;
`null` bedeutet, dass er noch nicht existieren darf. Zusätzliche
Sammlungsversionen sichern Ergebnisse einer seitenweisen Abfrage gegen
zwischenzeitliche Einfügungen und Löschungen ab.

Eine Operationskennung bezeichnet genau einen unveränderlichen Auftrag. Bei einer
Wiederholung muss der Adapter den ursprünglichen `MetadataReceipt` zurückgeben,
auch wenn spätere Änderungen die Ausgangsversion bereits ersetzt haben. Dieselbe
Kennung mit anderen Änderungen ist ein Konflikt. Datensätze, neue Versionen,
Änderungsjournal und Beleg müssen in derselben Transaktion gespeichert werden.
Der [DuckDB-Dienst](../sortsys-store/README.md) setzt diesen Vertrag um.

Normale Transportpakete sind auf 1.024 Änderungen, 8.192 Versionsprüfungen und
8 MiB Inhalt begrenzt. Größere Transaktionen verwenden ausdrücklich
`preparedMetadataBatch` beziehungsweise `MetadataBatch::validate_prepared`.
Auch dort braucht jede Änderung ihren vollständigen Versionsnachweis. Die
Grenzen betragen 400.000 Änderungen, 512.000 Prüfungen und 256 MiB; einzelne
Datensätze bleiben auf 1 MiB begrenzt.

Ein `PreparedMetadataManifest` benennt Zielkontext, Operationskennung,
Fingerabdruck und die geordnete Liste der unveränderlichen Transportfragmente.
`metadataFingerprint` und `MetadataBatch::fingerprint` berechnen denselben
SHA-256-Nachweis in TypeScript und Rust. JSON-Feldreihenfolge, Escaping und ein
weggelassenes leeres Journal ändern ihn nicht. Die Reihenfolge der Einträge in
Arrays bleibt Teil des Auftrags. Ein Adapter darf vorbereitete Fragmente noch
nicht als Änderungen veröffentlichen. Erst ein atomarer Abgleich des gesamten
Lesestands darf Daten, Journal und Beleg gemeinsam sichtbar machen.

Der Vertrag ersetzt keine Berechtigungsprüfung. Vor einer Veröffentlichung muss
der Anwendungsserver Signaturen und Zugriffsrechte prüfen und deren gelesene
Ausgangsversionen ebenfalls in die Transaktion aufnehmen. Ein allgemeiner
Metadaten-Schreibzugriff darf dem Browser deshalb nicht unmittelbar freigegeben
werden. Geschäftsinhalte gehören als Chiffrate in den Speicher; ihre fachliche
Prüfung bleibt beim entschlüsselnden Client.

## Versionsnachweise bei Rücksicherungen

`RecordAnchor` verknüpft einen öffentlichen oder verschlüsselten Zustand mit
einer fortlaufenden Version und dem SHA-256-Nachweis seines Vorgängers. Im Browser
erzeugt `advanceRecordAnchor(payload, previous)` den nächsten Kopf;
`verifyAnchorAdvance` prüft den Übergang. Rust verwendet entsprechend
`RecordAnchor::initial`, `next` und `follows`. Beide Implementierungen berechnen
denselben `anchorFingerprint` beziehungsweise `fingerprint`.

Die Nutzlast bleibt eine undurchsichtige UTF-8-Zeichenfolge. Sie kann etwa den
Hash eines signierten Sicherheitszustands enthalten. Ihre Signaturen und die
Bindung an Mandant und Objekt prüft weiterhin die Anwendung. Ein solcher
Versionsnachweis erteilt selbst keine Berechtigung.

Der Speicheradapter behandelt `zt-anchors` als geschützte Metadatensammlung.
Ein Kopf wird zusammen mit den zugehörigen Daten geändert und darf weder
gelöscht noch auf eine ältere Version gesetzt werden. Sein dauerhafter Zeuge
muss außerhalb der zurückgespielten Daten liegen. Der DuckDB-Adapter hält ihn
in `control.duckdb` und sichert einen ausstehenden Auftrag vor dem Commit der
Mandantendatei. Nach einem Abbruch spielt er genau diesen Auftrag mit seinen
ursprünglichen Versionsbedingungen erneut ab. Unklare Zustände bleiben gesperrt.

Für Zustände, die in anderen Datensätzen liegen, enthält die Nutzlast einen
`RecordCheckpoint`. `bindRecord(record, value)` bindet Sammlung, Datensatzkennung
und die genauen UTF-8-Bytes des gespeicherten Werts. `createRecordCheckpoint`
sortiert bis zu 64 Bindungen; `verifyCheckpointAdvance` erlaubt das Fortschreiben
und Ergänzen, aber kein Entfernen bestehender Kennungen. Die Rust-Entsprechungen
sind `RecordBinding::bind` und `RecordCheckpoint::{new, follows}`. Die Anwendung
entscheidet weiterhin, ob ein neuer Inhalt fachlich und kryptografisch zulässig
ist.

Der DuckDB-Adapter bewahrt die gebundenen Werte samt Version und Hash ebenfalls
in `control.duckdb` auf. Änderungen benötigen im selben Auftrag den nächsten
Kopf des besitzenden Checkpoints. Löschen, das Übernehmen durch einen anderen
Checkpoint oder der Wechsel zurück zu einer ungebundenen Nutzlast werden
abgewiesen. Beim Zugriff prüft der Adapter die angeforderten Werte gegen ihre
Bindungen; er hasht dafür nicht bei jeder Anfrage den gesamten Mandantenbestand.
Die Versionsprüfung erkennt auch ein älteres Tenant-Backup, dessen Autoritätskopf
unverändert ist, das aber eine spätere Sperre noch nicht enthält.

Die Aufbewahrung eines gebundenen Metadatensatzes sichert keine separat
referenzierte Datei. Für eine vollständige Rücksicherung müssen auch die
Chiffrate, Schlüsselumschläge und Katalogseiten verfügbar sein, auf die der
Datensatz verweist.

Werden sowohl die Daten als auch sämtliche unabhängigen Zeugen zurückgesetzt,
kann dieser Mechanismus den neueren Stand nicht mehr erkennen. Er ersetzt daher
keine unabhängige Aufbewahrung des aktuellen Sicherheitsstands und keine Prüfung
des vollständigen Rücksicherungsablaufs.

## Unveränderliche Ereignisse lesen

Das Modul `journal` beschreibt Ereignisse, die zusammen mit einem `MetadataBatch`
veröffentlicht werden. Ein Eintrag nennt seinen Bereich (`stream`), eine
unverwechselbare Kennung (`id`), das betroffene Objekt und den Zeitpunkt in
Mikrosekunden. `value` enthält einen verschlüsselten Inhalt oder technische
Verweise. Entschlüsselte Geschäftsinhalte gehören dort ebenso wenig hinein wie
in die übrigen Metadaten.

`MetadataBatch.journal` ergänzt dieselbe Transaktion wie die geänderten
Datensätze. Der Speicher vergibt die laufende `sequence` erst beim Commit.
Auch mehrere Ereignisse innerhalb einer Sammeländerung erhalten unterschiedliche
Nummern. Eine bereits verwendete Kombination aus Bereich und Ereigniskennung
kann nicht überschrieben werden. Eine wiederholte Operationskennung liefert
weiterhin den ursprünglichen Beleg, ohne zusätzliche Ereignisse anzulegen.
Die Einträge zählen zum gemeinsamen Schreib- und Größenlimit des Pakets.

`JournalQuery` begrenzt die Abfrage auf erlaubte Bereiche und Objektpräfixe.
Die Sortierung verwendet Zeitpunkt, `order` und laufende Nummer. Ohne ausdrücklich
angegebenes `order` verwendet der Speicher dafür ebenfalls die laufende Nummer.
Damit können bestätigte historische Quellen ihre ursprüngliche Reihenfolge
beibehalten. Die Anwendung muss einen solchen Herkunftsnachweis selbst prüfen.

Eine erste Seite liefert `snapshot` und gegebenenfalls `after`. Folgeseiten
übernehmen beide Werte. Später veröffentlichte Ereignisse verändern diese Seiten
auch dann nicht, wenn ihr angegebener Zeitpunkt weiter zurückliegt. Für eine
bedingte Neuladung stehen `known` und `knownTotal` bereit. Diese Werte lassen sich
nicht mit einer Seitenabfrage kombinieren.

Die Implementierung und die Abfrageindizes liegen im
[DuckDB-Dienst](../sortsys-store/README.md). Das Framework enthält die gleichen
Datentypen und Eingabeprüfungen für Rust und TypeScript; es benötigt dafür weder
einen Datenbanktreiber noch sortsys-Fachmodelle. Ein Journaleintrag beweist allein
noch keine fachliche Richtigkeit oder Vollständigkeit eines Archivs. Die
Anwendung prüft weiterhin die signierten Originale und die aktuellen Leserechte.
