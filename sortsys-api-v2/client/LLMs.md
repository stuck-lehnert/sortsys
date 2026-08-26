# Supported procedures

This list reflects the Rust-generated contract. Procedures absent here are not available.

## Queries

- `ping`
- `auth.check`
- `auth.sessionInfo`
- `clientScripts.get`
- `clientScripts.list`
- `remarks.list`

## Mutations

- `auth.login`, `auth.logout`
- `clientScripts.create`, `clientScripts.update`, `clientScripts.delete`
- `errorReports.report`
- `remarks.create`, `remarks.update`, `remarks.delete`

Use `query`, `streamQuery`, and `mutate` from `@sortsys/v2-client`.
