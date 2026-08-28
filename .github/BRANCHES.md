# CI and branch flow

The repository uses three trusted, long-lived branches:

- `master` contains ongoing work. CI runs after every push and for pull requests targeting `master`.
- `predeploy` marks a revision for release.
- `deploy` contains the latest deployable revision.

A push to `predeploy` runs the same checks as `master`. When they pass, CI fast-forwards `deploy` to the exact tested commit. A failing check leaves `deploy` unchanged. The promotion fails if `predeploy` no longer contains the current `deploy` history; create a revert on `master` when rolling back a release.

Run the same checks locally with:

```bash
./scripts/ci
```

## Initial GitHub setup

Commit the workflow to `master`, then create the two release branches:

```bash
git push origin master:predeploy
git push origin master:deploy
```

Keep `master` as the default branch. Under **Settings > Actions > General > Workflow permissions**, allow read and write access for `GITHUB_TOKEN`.

No rulesets, GitHub App, repository variables, or deployment secrets are required. This setup intentionally treats anyone with branch write access as trusted.

## Releasing

Push the current `master` revision to `predeploy`:

```bash
git push origin master:predeploy
```

GitHub runs the complete test job once. If it succeeds, the promotion job fast-forwards `deploy`. No workflow runs again on `deploy`.
