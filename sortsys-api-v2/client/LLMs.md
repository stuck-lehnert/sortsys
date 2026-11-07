# Ausgewählte API-Prozeduren

Die Liste enthält eine Auswahl der API-Prozeduren. Alle verfügbaren Prozeduren
mit ihren Typen stehen im erzeugten Vertrag unter `src/generated/contract.ts`.

## Abfragen

- `ping`
- `auth.check`
- `auth.sessionInfo`
- `clientScripts.get`
- `clientScripts.list`
- `remarks.list`

## Änderungen

- `auth.login`, `auth.logout`
- `clientScripts.create`, `clientScripts.update`, `clientScripts.delete`
- `errorReports.report`
- `remarks.create`, `remarks.update`, `remarks.delete`

Aufrufe verwenden `query`, `streamQuery` und `mutate` aus `@sortsys/v2-client`.
