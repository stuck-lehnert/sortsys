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

`reconcilePolicyRules(current, desired, managed)` gleicht einen abgegrenzten
Bestand automatisch abgeleiteter Regeln ab. `managed` bestimmt, welche Regeln
die Anwendung dabei ersetzen darf. Unabhängige Freigaben und Sperren bleiben an
ihrer bisherigen Stelle. Fachlich identische Regeln behalten auch ihre bisherige
Darstellung, wenn die Feldreihenfolge einer JSON-Antwort oder die Reihenfolge
der Aktionen abweicht. Dadurch erfordern wiederholte Abgleiche keine neue
Regelsignatur. Veraltete und doppelte eigene Regeln werden entfernt; neue kommen
hinzu. Die Funktion signiert und veröffentlicht nichts. Die Eingaben müssen
weiterhin mit dem konfigurierten Regelcodec geprüft werden.

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
`policy.validateRules` prüft anschließend die gesamte Liste, etwa wenn eine
Rollenzuweisung mehrere vorgeschriebene Regeln gemeinsam enthalten muss.
Die serverseitige Prüfung muss dieselben Bedingungen anwenden.
`policy.validateSuspendedSubject` erlaubt zusätzliche Beschränkungen des
Benutzerkennungsformats. Dieselben fachlichen Beschränkungen müssen auch auf
der Serverseite gelten.

## Einzelne Datensätze freigeben

Ein Bereich kann mehrere vertrauliche Datensätze enthalten, von denen eine
Person nur einen sehen soll. `security.objects.shareObjectKey` verpackt dafür
den zufälligen Schlüssel dieses Datensatzes für den Empfänger. Der
Bereichsschlüssel wird nicht weitergegeben. Empfänger öffnen mit
`decryptSharedObject` dasselbe signierte Chiffrat; eine zusätzliche Klartextkopie
ist nicht erforderlich.

Das Beispiel verwendet die zuvor verschlüsselte Notiz.
`verifiedRecipientKey` ist der öffentliche X25519-Schlüssel als `CryptoKey`;
dessen Zertifikat und aktueller Zugang müssen bereits geprüft sein.

```ts
const share = {
  authorityGeneration: "1",
  recipient: "patient:ada",
  author: "doctor:lee",
};
const envelope = await security.objects.shareObjectKey({
  object: encrypted,
  expected: context,
  wrappingKey: key,
  objectSigner: identity.signingKey.publicKey,
  share,
  recipientKey: verifiedRecipientKey,
  signingKey: identity.signingKey.privateKey,
});
```

Beim Öffnen werden `object`, `expected`, `objectSigner`, `envelope` und `share`
an `decryptSharedObject` übergeben. `recipientKey` ist dann der private
Entschlüsselungsschlüssel des Empfängers; `grantSigner` ist der geprüfte
öffentliche Signaturschlüssel des Ausstellers. Ein anderer Aussteller als der
ursprüngliche Objektautor ist möglich, etwa für eine spätere zulässige Freigabe.

Das Schlüsselpaket verwendet den Zweck `object-key` und bindet die vollständige
signierte Chiffratrevision einschließlich Mandant, Bereich und Inhaltsart. Jede
neue Revision besitzt bereits einen neuen zufälligen Datensatzschlüssel. Eine
frühere Freigabe öffnet deshalb weder einen anderen Datensatz noch dessen neue
Revision. Löschmarkierungen lassen sich nicht freigeben. Die
Autoritätsgeneration in `share` ist unabhängig von der Schlüsselgeneration des
Datensatzes und muss aus dem aktuellen vertrauenswürdigen Sicherheitsstand
stammen.

Rust prüft denselben Nachweis mit `object_shares::verify`. Die Anwendung muss
Aussteller und Empfänger zertifizieren und deren aktuelle Berechtigungen prüfen.
Die Freigabe gehört zusammen mit der jeweiligen Objektversion in dieselbe
Speichertransaktion. Beim Lesen muss der Server die aktuelle Freigabe und
Objektversion auswählen; eine gültige frühere Signatur allein erlaubt kein
erneutes Öffnen. Ein bereits entschlüsselter früherer Stand lässt sich nicht
zurückholen.

`objectKeyRecipientBinding(recipient, envelope)` bindet das genaue
Empfängerzertifikat und Schlüsselpaket an das Feld `binding` eines
`ResourceAccessState`. `null, null` ergibt eine ausdrückliche leere Bindung;
nur einen der beiden Werte wegzulassen ist ungültig. Rust berechnet denselben
Wert mit `object_shares::recipient_binding`. Der Speicheradapter muss diesen
signierten Zugriffsstand für jedes freigabefähige Objekt verlangen, auch wenn
aktuell kein Empfänger vorgesehen ist. Sonst ließe sich eine Freigabe aus der
Speicheranfrage entfernen, während das Chiffrat trotzdem gespeichert und
bestätigt wird. Ein vorhandener aktiver Nachweis passt nach dem Entfernen des
Schlüsselpakets nicht mehr zur leeren Bindung.

Bei einer Recovery bleibt der Datensatz über den vorhandenen Bereichsschlüssel
wiederherstellbar. Freigaben an erneuerte Empfängerschlüssel benötigen neue
Schlüsselpakete unter der aktuellen Autoritätsgeneration. Die Bibliothek
entscheidet nicht, welche früheren Empfänger wieder Zugang erhalten dürfen.

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

Beim Wechsel auf einen älteren Fachstand kann die Anwendung die Schreibversion
mit `signPolicyContinuation(previous, binding, authorityKey)` erhöhen.
Bei delegierten Regeln bindet die Signatur den bisherigen Richtlinienstand und
den Fingerabdruck des neuen Fachstands. Die vorhandenen Profile, ihre
Unterzeichner und der primäre Stand bleiben erhalten. Rust prüft die Bindung
mit `PolicyRef::continues` nach der Signaturprüfung beider Richtlinien.
Der Speicheradapter darf diesen Übergang nur gemeinsam mit dem zugehörigen
Fachstand veröffentlichen.

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

`RecoverySource.domainProofs` enthält die signierte Definition der deklarierten
aktuellen Generation jedes Bereichs. Für historisch fremd signierte
Schlüsselpakete kommen deren ursprüngliche Definitionen hinzu. Jede Definition
muss zur exakten Schlüsselgeneration und Recovery-Hülle gehören. Die Prüfung
bindet Mandant, Bereich, Inhaltstyp und Generation an die durch die Phrase
bestätigte Autorität. Ein Schlüsselpaket allein enthält diesen vollständigen
Bereichsnachweis nicht.

`loadRecoverySource` übernimmt die nötigen Definitionen aus den vorhandenen
Bestandsseiten; zusätzliche Anfragen sind dafür nicht nötig. `prepareRecovery`
prüft sie vor dem Öffnen des Archivs und vor einer neuen Kontoregistrierung.
Fehlende, doppelte oder veränderte Nachweise werden abgelehnt, ebenso eine
andere Recovery-Hülle neben einer gültigen Definition. Ein Benutzerkonto oder
ein privater Verwalterschlüssel wird für diese Prüfung nicht benötigt.

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

### Signierte Befehle für einzelne Ressourcen

`createResourceCommandKey()` erzeugt einen Prüfschlüssel und den zugehörigen
privaten Seed. `resourceCommandBinding(verificationKey)` berechnet daraus die
SHA-256-Prüfsumme für `ResourceAccessState.commandBinding`. Der Seed gehört
in einen Schlüsselumschlag für das Konto, das den Befehl ausführen darf.
Andere berechtigte Ansichten benötigen nur den Prüfschlüssel.

`signResourceCommand` unterschreibt Mandant, Zweck, Revision und Ausgabezeit
in Millisekunden. `verifyResourceCommand` prüft den Nachweis gegen den
erwarteten Mandanten, Zweck und die gespeicherte Bindung. Rust verwendet
denselben Rahmen für `resource_access::ResourceCommand`. Bei Annahme eines
Befehls muss die Anwendung in derselben Transaktion Berechtigung, aktuelle
Revision, Zeitfenster und die bisherige Ausführung prüfen. Historische
Ansichten verwenden denselben Nachweis zur Signaturprüfung.

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

## Signaturschlüssel erneuern

Ein Identitätszertifikat kann mit `previousSignature` seinen unmittelbaren
Vorgänger derselben Mandanten-, Autoritäts- und Benutzerkennung benennen.
`identityCertificateFrame` bindet diesen Verweis an die Signatur der Autorität.
Rust prüft dieselben Bytes mit `protocol::IdentityCertificate::frame`; `succeeds`
prüft die genaue Nachfolgebeziehung. Ein initiales Zertifikat hat keinen
Vorgänger.

`identityCertificateHeads` prüft vollständige, unverzweigte Ketten unabhängig
von ihrer Eingabereihenfolge. Die Signaturen müssen vorher geprüft werden.
`verifyTrustHistory` erledigt beides und gibt mit `identityCertificate` das
aktuelle Zertifikat zurück. `proofSigner(subject, generation, signature, frame)`
findet dagegen den passenden historischen Prüfschlüssel für genau diesen
Nachweis. `verifyIdentityProof` verwendet denselben Prüfer. Ein altes Zertifikat
bleibt so für historische Inhalte nutzbar, ohne wieder zum aktuellen Schlüssel
zu werden.

Ein Speicheradapter darf Zertifikate nicht überschreiben. Er muss den
bisherigen aktiven Kopf und den Kontostand innerhalb derselben Transaktion
vergleichen, bevor er einen Nachfolger aktiviert. Die Anwendung prüft
zusätzlich die Berechtigung zur Erneuerung; eine historische Signatur allein
autorisiert keinen neuen Schreibzugriff.

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

## Kontokennung und Anmeldename

Passwortanmeldung und Kontotresor verwenden eine unveränderliche Kennung:
`{ tenant, subject }`. `credentialIdentifier` kodiert beide Bestandteile mit
eindeutigen Feldgrenzen; `opaqueIdentifiers` liefert die zugehörigen
OPAQUE-Identifikatoren. Rust stellt dieselbe Kodierung über
`credentials::CredentialPrincipal::identifier` bereit.

`subject` bezeichnet das Konto und darf nicht aus einem veränderbaren
Anmeldenamen abgeleitet werden. sortsys verwendet dafür `user:<Kontokennung>`.
Andere Anwendungen können eigene Kennungen verwenden. Der Anmeldename bleibt
getrennte Anmeldemetadaten und ist kein Feld des `AccountVault`.

`createAccountVault(exportKey, tenant, subject, identity, pins)` verschlüsselt
den Kontotresor für diese Kennung. Zum Öffnen müssen Mandant und Kennung erneut
angegeben werden. Auch der lokale Gerätespeicher sucht über `tenant` und
`subject`; ein geänderter Anmeldename erfordert deshalb keine neue lokale
Schlüsselkopie. Die Formate `sortsys-account-v2` und
`sortsys-passkey-vault-v2` binden diese Felder kryptografisch.

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
`unlock.openVault({ tenant, subject }, keyVault, accountVault)` denselben
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

Rusts Modul `webauthn` prüft ES256-Registrierungen mit `none`-Attestierung und
anschließende Anmeldesignaturen. `Origin::parse` legt die erlaubte Herkunft und
RP-Kennung fest. `verify_registration` liefert den geprüften öffentlichen
Schlüssel samt Credential-Kennung und Authenticator-Zustand;
`verify_authentication` benötigt dieses Ergebnis erneut. Beide Prüfungen
verlangen Benutzeranwesenheit und Benutzerverifikation. Anschließend prüft
`AuthenticatorState::follows` Zähler und Backup-Kennzeichen. Die Grenzen und
Felder folgen [WebAuthn Level 3](https://www.w3.org/TR/webauthn-3/).

Eine gültige technische Sitzung allein soll keinen neuen dauerhaften Zugang
erlauben. Deshalb signiert das entsperrte Konto zusätzlich
`passkeyRegistrationFrame`: Mandant, unveränderliche Kontokennung, User Handle,
Challenge-Token, das genaue öffentliche Registrierungspaket, das optionale
Schlüsselpaket und der Gerätename sind darüber gebunden. Rust stellt denselben
Rahmen als `webauthn::RegistrationBinding::frame` bereit. Für die Paketbindung
dienen `registrationCredentialFrame` und `webauthn::registration_frame`; für das
signierte Schlüsselpaket dient `passkeyVaultDigest`. Auch das Löschen benötigt
eine Kontosignatur über `passkeyDeletionFrame` beziehungsweise
`webauthn::deletion_frame`.

`routingUserHandle(tenant, subjectBytes)` verpackt den Mandanten-Fingerabdruck
und bis zu 31 anwendungseigene Bytes in höchstens 64 Bytes. Das Format enthält
keinen veränderlichen Anmeldenamen. Rust verwendet `routing_user_handle` und
`parse_routing_user_handle`. Ein User Handle ersetzt keinen Identitätsnachweis:
Der Speicheradapter muss zusätzlich die registrierte Credential-Kennung und
deren kontogebundene Signatur prüfen und doppelte Zuordnungen innerhalb der
RP-Kennung ausschließen.

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

Über `createZeroTrust({ facets, setup: { ownerGrants } })` kann eine Anwendung
dem Inhaber auch Rechte für Bereiche ohne verschlüsselte Datensätze geben.
Ein Anlegerecht kann zum Beispiel aus `scope: "create:appointment"`,
`facet: "appointments"` und `actions: ["create"]` bestehen. Der Einrichtungscode
signiert diese Rechte sowohl für das erste Konto als auch für den Inhaber nach
einer Recovery. Der Serveradapter bestimmt, welche zusätzlichen Regeln er in
der signierten Einrichtungsrichtlinie akzeptiert.

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

Mit `administrator: { subject, username, version }` kann ein vorhandenes Konto
beibehalten werden. `existingRecoveryAccount` prüft diese Beschreibung;
`recoveryAccountFrame` beziehungsweise Rusts `recovery::account_lookup_frame`
liefern den zweckgebundenen Seed-Nachweis für ihren Abruf. Der Adapter liefert
als `version` einen undurchsichtigen Prüfwert des aktuellen technischen
Kontostands. Er muss das zulässige Ziel selbst bestimmen und gelöschte oder
gesperrte Konten ausschließen.

Die OPAQUE-Registrierung und der vollständige Recovery-Plan binden diesen Wert
über `accountVersion` an ihre Signaturen. Der Adapter vergleicht ihn auch in der
abschließenden Transaktion. So kann ein alter Plan weder eine parallele
Passwortänderung noch eine Umbenennung überschreiben. Fehlt `administrator`,
wird weiterhin ein unabhängiges Konto über `createAdministrator` vorbereitet.
Beide Wege erzeugen neue private Schlüssel und eine neue Seed-Generation;
historische Signaturen behalten ihre ursprünglichen Zertifikate.

### Weitere Konten mit einer Seed-Recovery wiederherstellen

`prepareRecovery` nimmt optional `members` mit je einem geprüften
`ExistingRecoveryAccount` und dem neuen Passwort entgegen. Es erzeugt die
OPAQUE-Registrierung, einen neuen verschlüsselten Kontotresor und ein von der
neuen Mandantenautorität signiertes Identitätszertifikat. Die Benutzerkennung
bleibt erhalten; private Schlüssel und Passwörter verlassen den Browser nicht.
Die Registrierungsfunktion erhält nur den öffentlichen Antrag mit Seed-Nachweis.

`recoveryMemberFrame` bindet die vorherige Kontoabfrage an Mandant,
Autoritätsgeneration, Anmeldenamen und Zufallswert.
`recoveryMemberRegistrationFrame` bindet die Registrierung an den genauen
Kontostand. `recoveredMembersFrame` prüft bis zu acht eindeutige Konten und nimmt
sämtliche Ersatznachweise in die beidseitig signierte Recovery-Bindung auf. Rust
bietet dieselben Prüfungen mit `recovery::RecoveredMember` und
`recovery::recovered_members_frame`. Gemeinsame Browser-Testvektoren prüfen die
Bytefolge beider Implementierungen.

Der Speicheradapter muss alle ursprünglichen Kontostände, ihre aktiven
Anmeldenamen und den Recovery-Kopf in derselben Transaktion vergleichen. Er darf
keine Sperren aufheben oder Mitarbeiter zu Administratoren machen. Beide
Kontenarten und der Phrase-Wechsel müssen gemeinsam veröffentlicht werden.
Historische Zertifikate bleiben bestehen; alte Sitzungen und Passkeys werden
gesperrt. Diese Registrierung verteilt noch keine Inhaltsberechtigungen. Die
Anwendung muss die weiter geltenden Freigaben anschließend bestätigen und die
bereits gesicherten Bereichsschlüssel an die neuen Identitäten verteilen.

Ein Speicheradapter muss den Wechsel nach Prüfung der alten und neuen
Nachweise atomar übernehmen. Die verbrauchte Generation und Challenge dürfen
nicht erneut verwendet werden. Ein zweiter Aufruf darf nur denselben bereits
vorbereiteten Wechsel fertigstellen. Transaktionen, Sperren und Versionsvergleiche
gehören zum Adapter; sie lassen sich durch die Signaturprüfung allein nicht ersetzen.
Diese Vorbereitung gehört zum allgemeinen Kern und unterstützt wiederholte
Wiederherstellungen. Der Anwendungseinstieg ergänzt dafür seine fachlichen
Herkunftsprüfungen; die Übernahme in den dauerhaften Speicher bleibt beim Adapter.

Der Sortsys-Einstieg ergänzt `creationRenewalFrame` für vorhandene
Werkzeugbuchungen, deren Freigaben nach einer Recovery neu bestätigt werden.
Der Rahmen bindet die Nachweise beider Buchungsbereiche sowie Kennung, Revision
und Signatur des verschlüsselten Ausgangsdatensatzes. Die aktuelle
Mandantenautorität muss ihn zusätzlich signieren. Der API-Adapter prüft die
Signatur, den aktuellen Ausgangsstand und die beiden vorhandenen Bereiche in
einer Transaktion. Er darf vorhandene Nachweise dabei nicht ersetzen. Eine
identische Wiederholung lässt auch einen inzwischen ergänzten
Aktivitätsnachweis unverändert. Diese Bestätigung ersetzt keine fachliche
Zuständigkeitsprüfung und gewährt selbst keine Mitarbeiterrechte.

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

Für eine laufende Ansicht fasst `latestQuery(read, receive, failed)` mehrere
`refresh()`-Aufrufe zusammen. Läuft bereits ein Lesevorgang, wird dessen Ergebnis
verworfen und einmal neu gelesen. `close()` verhindert weitere Rückmeldungen,
bricht aber keinen laufenden Transport ab. Sitzungsprüfung und Abbruchsignal
bleiben beim Adapter.

`createCursorHistory(firstPage, pageSize, keyOf?)` hält die bereits geladenen
Zeilen einer Ansicht. Der erste Datensatz pro `keyOf` bleibt erhalten; ohne
Angabe ist das die Kennung `id`. Für die nächste Anfrage zählt die letzte
Kennung der gelieferten Seite, auch wenn diese Zeile schon angezeigt wird.
Eine kürzere Seite beendet die Abfrage. Schlägt ein Abruf fehl, bleiben Zeilen
und Cursor für einen erneuten Versuch erhalten. Für einen neuen Anfangsstand
oder beim Sitzungswechsel wird eine neue Instanz verwendet. Der Lade-Callback
muss Berechtigungen und Daten prüfen; der Helfer prüft keine Signaturen.

Rusts `pagination::SnapshotPage::from_lookahead` übernimmt höchstens eine
zusätzliche Zeile aus der Datenbankabfrage. Ihr Vorhandensein erzeugt einen
Fortsetzungscursor für die letzte tatsächlich ausgelieferte Zeile. Der zusätzliche
Datensatz wird erst auf der nächsten Seite ausgegeben.

Die Seitenstruktur ist kein Echtheitsnachweis. Signaturen, erwarteter Mandant,
Berechtigungen und Inhaltsschema müssen weiterhin geprüft werden. Für den
Recovery-Katalog verbindet `security.recovery.loadRecoverySource` die Seiten mit
dem zuvor gelesenen Kopf. `recoveryPageFrame` beziehungsweise Rusts
`recovery::RecoveryPageAccess::frame` binden eine Anfrage an Mandant, Generation,
Challenge, Snapshot und Cursor. Eine Seite enthält höchstens
`RECOVERY_INVENTORY_PAGE_ITEMS` Einträge. Der Transport-Callback erhält keine
Seed-Phrase.

Die Standardkapazität beträgt 2.000 Bereiche und 50.000 Schlüsselstände.
`RecoveryInventory` zählt Bereiche und veröffentlichte Schlüsselgenerationen.
Ältere Generationen zählen nach einem Phrase-Wechsel weiter. Für einzelne
Schlüsseländerungen lassen `RecoveryInventory::reserve` in Rust und
`reserveRecoveryInventory` in TypeScript je Bereich einen Schlüsselstand frei.
Für die Recovery verbrauchen `RecoveryInventory::rotate` und
`rotateRecoveryInventory` je Bereich einen Stand aus dieser Reserve. Der
Speicheradapter muss den neuen Zähler zusammen mit den Schlüsseln gegen den
gelesenen Stand veröffentlichen.

Andere Anwendungen können `recovery.inventoryLimits` bei `createZeroTrust`
angeben und dieselben `RecoveryLimits` an ihren Rust-Adapter übergeben. Die
Konfiguration wird beim Erzeugen des Codecs kopiert. Die Kapazitätsgrenzen
ersetzen keine Prüfung der tatsächlichen Datensatz- und Transportgrößen.
Insbesondere bleibt die vollständige Vorbereitung und Veröffentlichung auf den
gesamten Bestand bezogen; unvollständige Bestände werden abgelehnt.

## Unabhängige Arbeit begrenzen

`mapConcurrent(einträge, grenze, verarbeiten)` startet höchstens `grenze`
Aufgaben gleichzeitig und liefert die Ergebnisse in Eingabereihenfolge.
Beim ersten Fehler startet die Funktion keine weiteren Aufgaben. Sie wartet
auf bereits gestartete Aufgaben, bevor sie den Fehler weitergibt. Dadurch
können gemeinsam genutzte Ressourcen anschließend sicher geschlossen werden.
Die Funktion prüft keine Rechte und macht Schreibvorgänge nicht atomar.

`pendingReads(lesen, kopieren)` bündelt gleichzeitig laufende Leseaufrufe mit
demselben Pfad und denselben einfachen Eingabedaten. Eine abgeschlossene
Antwort bleibt nicht gespeichert. Jeder Aufrufer erhält das Ergebnis über
`kopieren`. Bei einem Konto- oder Datenwechsel trennt `clear()` die laufenden
Aufrufe von neuen Anfragen; die Anwendung bleibt für die Gültigkeitsprüfung
und den Abbruch bereits laufender Aufrufe zuständig. `clear(prüfen)` kann die
Invalidierung auf einzelne Pfade beschränken.

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

### Fachstände getrennt zurücksetzen

Eine Rücksicherung von Geschäftsdaten darf keine zurückgezogenen Freigaben oder
alten Anmeldedaten wieder aktivieren. `ContentEpoch` beschreibt deshalb einen
eigenen, durch die Mandantenautorität signierten Wechsel des Fachstands. Der
Nachweis bindet Mandant, ausführende Person, aktuelle Autoritätsgeneration,
Vorgänger, gewählten Ausgangsstand und den SHA-256-Hash der geschlossenen
Sicherungsdatei. `signContentEpoch`, `verifyContentEpoch` und
`contentEpochFollows` erzeugen und prüfen diese Nachweise. Rust bietet dieselben
Prüfungen über `content_epoch::ContentEpoch`.

Der Ausgangsstand hat die Nummer `0`; jede Rücksicherung erhöht die Nummer um
eins. Auch ein älterer veröffentlichter Stand kann erneut als Quelle dienen.
Der Adapter muss Vorgänger und Quelle aus seiner bereits geprüften Historie
laden. Eine gültige Signatur eines nie veröffentlichten Seitenzweigs genügt
nicht. Autorisierung, Prüfung der Sicherungsdatei und Veröffentlichung des
neuen Kopfes gehören in denselben atomaren Ablauf.

Wenn ein Client vor der Freigabe verschlüsselte Verknüpfungen prüft, kann er
die Beobachtung mit `signContentReview` bestätigen. Die Bestätigung bindet
Auftrag, signierte Auswahl und einen vom Speicheradapter gelieferten
Fingerabdruck. `content_epoch::ContentReview::verify` prüft die Signatur.
Die Anwendung legt fest, welche Versionen der Fingerabdruck erfasst. Sie
muss dieselben Versionen in der Freigabetransaktion vergleichen und die
Freigabe bei einer Änderung abbrechen.

`namespaceRecord(record, number)` bildet eine logische Metadatenkennung auf
eine getrennte Sammlung ab; `logicalRecord` prüft die umgekehrte Zuordnung.
Objektkennungen bleiben erhalten. Die Anwendung legt ausdrücklich fest, welche
Sammlungen Geschäftsdaten enthalten. Konten, Berechtigungen, Recovery-Nachweise
und ihre unabhängigen Zeugen müssen beim aktuellen Stand bleiben.

Ein `ContentPin` bindet einen aufzubewahrenden Datensatz dauerhaft an seine genaue
physische Sammlung. `contentPinKey` liefert dafür eine nach logischen Kennungen
sortierbare Ablagekennung. Der Adapter muss diese Bindung selbst gegen Änderungen
schützen, beim Lesen berücksichtigen und die referenzierten Chiffrate erhalten.
Ob der Inhalt endgültig gesperrt ist oder berechtigt fortgeschrieben werden darf,
prüft die Anwendung weiterhin. So kann beispielsweise ein Rechnungszähler seinen
aktuellen Stand behalten und trotzdem die nächste Nummer vergeben.
Die Funktionen führen noch keine Rücksicherung durch. Insbesondere ersetzen sie
weder einen atomaren Speicherwechsel noch die Behandlung laufender
Dokumentsitzungen und fachlicher Abhängigkeiten.

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
