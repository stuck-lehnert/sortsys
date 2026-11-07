# CI and branch flow

- Every branch push runs the repository tests through `scripts/ci`.
- A successful push to `predeploy` fast-forwards `deploy` to that tested commit.
  Failed tests or a superseded `predeploy` commit leave `deploy` unchanged.
- On `deploy`, the container workflow builds the API, job runner and webapp from
  their normal Dockerfiles and publishes them to GHCR, tagged `latest` and with
  the first ten characters of the commit SHA.

The CI workflow only listens to branch pushes. Opening or updating a pull request
in this repository does not run the same commit's tests a second time. Tags do
not start CI. A direct push to `deploy` triggers its tests and container workflow;
normal releases go through the tests on `predeploy` first.

Run the same tests locally with:

```bash
./scripts/ci
```

## GitHub setup

Keep `master` as the default branch and create the release branches once:

```bash
git push origin master:predeploy
git push origin master:deploy
```

The workflows request their required `GITHUB_TOKEN` permissions: tests are read
only, promotion needs contents/actions write, and publication needs packages
write. Repository or organization policy must allow these permissions. No PAT,
GitHub App or additional secret is required.

Promotion uses a normal fast-forward push, never a history rewrite. Because a
push made with `GITHUB_TOKEN` does not trigger another push workflow, the same
promotion job explicitly starts `publish-containers.yml` on `deploy` using
`workflow_dispatch`. [GitHub documents this token behavior and the dispatch
exception](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow).
Merge the workflows to the default branch before using this release flow.

## Releasing

```bash
git push origin master:predeploy
```

The tests must finish successfully before promotion. If `predeploy` changes while
its tests run, the older run cannot promote it. Divergent `deploy` history is
rejected by Git; integrate that history before retrying. Roll back with a revert
commit rather than resetting the release branches.

`Publish containers` can also be rerun manually on `deploy` if publication fails
after promotion. It will not publish when dispatched on another branch. Container
publishing is serialized and does not interrupt an in-progress release.

The CI does not transfer compiled artifacts between jobs or maintain custom
remote build caches. Ordinary caches within an individual Docker build still
work. Populated deploy-upgrade and runtime-container checks remain local tools;
they are not extra workflow stages or prerequisites of promotion.
