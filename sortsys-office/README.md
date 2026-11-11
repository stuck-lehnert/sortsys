# Office-Dokumente im Browser

Dieser Dienst stellt CryptPads angepasste Office-Editoren und den verschlüsselten
Abgleich gemeinsamer Sitzungen bereit. DOCX-, Tabellen- und Präsentationsdateien
werden im Browser geöffnet, konvertiert und wieder gespeichert. Die API liefert
keine Klartext-Datei an einen Dokumentserver.

Der Build verwendet CryptPad `86dc5ae80daa47f3b46487da9b33aeeb38846899` und die im
Quellstand festgelegten Editor- und WASM-Archive `v9.3.2+3`. Quellarchiv und
Office-Archive werden anhand ihrer Prüfsummen geprüft. Die ungenutzte
CKEditor-Anwendung samt deren Beispielseiten wird aus dem Image entfernt.
Upstream-Lizenzen bleiben
im Image enthalten; CryptPad und seine Office-Anpassungen stehen unter ihren
jeweiligen AGPL-Lizenzen.

Ein kleiner, beim Build geprüfter Quellpatch verbindet die PDF-Ausgabe mit dem
browserseitigen Druckweg. Projektdateien verwenden dauerhafte verschlüsselte
Räume; ungespeicherte Exportansichten behalten CryptPads temporäre Räume.

`OFFICE_PUBLIC_ORIGIN`, `OFFICE_SANDBOX_ORIGIN` und `SORTSYS_PUBLIC_ORIGIN`
bezeichnen drei verschiedene Origins. Im Betrieb verwenden sie HTTPS; lokale
Tests dürfen Loopback-Adressen mit HTTP verwenden. Haupt- und Sandbox-Domain
werden auf denselben Port `8080` geroutet. Interne CryptPad-Ports sind nur an
Loopback gebunden.

`/var/lib/sortsys-office` enthält verschlüsselte Sitzungsstände und gehört zur
Sicherung. Die automatische Verdrängung alter Sitzungen ist abgeschaltet.
Ein Integrationstest schließt alle Clients, startet den Dienst neu und öffnet
den gemeinsamen Stand erneut mit dem Leseschlüssel.
Klartext-Download- und Speicher-Callbacks sind am vorgeschalteten Nginx gesperrt.
Die CSP begrenzt Netzwerkzugriffe auf die beiden Editor-Origins; fremde
Netzwerkbilder und entfernte Konvertierungsdienste sind darüber nicht erreichbar.

Die [Editorbeschreibung](../docs/editoren-ohne-klartextserver.md) erläutert die
Einbindung, Rechte und den noch ausstehenden Funktionsabgleich.
