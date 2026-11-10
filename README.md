# ghcr-prune

Deletes container image versions from the GitHub Container Registry (ghcr.io) that nothing
needs any more, without breaking the images you keep.

A multi-arch or attested image is one tagged index plus untagged manifests: one per platform
and one per attestation. GHCR lists all of them as separate package versions. "Delete untagged
versions" breaks tagged images, and "delete old tags" leaves their manifests behind forever.
ghcr-prune decides what to keep, follows every kept index down to the manifests it lists, and
deletes the rest.

One Node file, no dependencies, no build step. Organisation-owned packages only.

## Rules

A version is kept when at least one of these holds:

| Rule | Flag / input |
|---|---|
| It is among the newest *n* tagged versions of its package | `keep-newest` (required, ≥ 1) |
| It was updated within the last *d* days | `min-age-days` (required) |
| One of its tags matches a regular expression | `keep-tags` |
| A file names it as `[…/]<package>[:tag]@sha256:<digest>` | `keep-refs` |
| A kept index lists it, directly or nested | always |

Everything else is deleted. The age guard covers builds still in flight, e.g. platform
images pushed before their index exists. `keep-refs` is for digests pinned elsewhere, such as
deployment manifests; any text file works, and a file without a single reference is an
error, not an empty list. The files are read once at the start: a digest pinned while a run
is deleting is not protected by that run.

## GitHub Action

```yaml
on:
  schedule:
    - cron: "0 5 * * 1"
  workflow_dispatch:

permissions:
  contents: read

jobs:
  prune:
    runs-on: ubuntu-24.04
    permissions:
      packages: write
    steps:
      - uses: civico-de/ghcr-prune@v2
        with:
          packages: |
            my-app
            my-app-cache
          keep-newest: 5
          min-age-days: 2
          keep-tags: |
            ^v\d
            ^latest$
          apply: true
          max-delete: 500
```

`packages` names the packages explicitly: the workflow token cannot list an
organisation's packages (`400 Invalid argument`). With `packages: write`, it can read and
delete versions of the packages the calling repository publishes. `apply` defaults to a dry run. `max-delete` caps one
run; the rest waits for the next one, which keeps a large first cleanup within the API rate
limit.

Each run writes the counts to the job summary and every decision as JSON lines to the
artifact `ghcr-prune-<attempt>` (`artifact-name` changes the prefix, e.g. per matrix job).

## CLI

```sh
node ghcr-prune.ts --org <org> --package <name> --keep-newest 5 --min-age-days 2 \
  --keep-tag '^v\d' --keep-refs pins.txt            # dry run
node ghcr-prune.ts ... --apply --max-delete 500     # delete
```

`--package` is repeatable. The token is
`$GITHUB_TOKEN`, otherwise `gh auth token`; deleting needs the `delete:packages` scope and
admin rights on the package. Needs Node ≥ 22.18 (runs TypeScript directly).

Decisions go to stdout as JSON lines (`keep`, `would-delete`, `deleted`, `deferred`, each
with its reason), counts to stderr. All packages are decided before the first delete, so a
manifest that cannot be read aborts the run without deleting anything.

## Recovery

GitHub keeps a deleted version restorable for 30 days: package settings → *Restore*, or
`POST /orgs/<org>/packages/container/<package>/versions/<id>/restore` with the `id` from the
JSON lines.

## Development

```sh
node --test --experimental-test-coverage ghcr-prune.test.ts
```

## Licence

AGPL-3.0, see [LICENSE.md](LICENSE.md). Contact: johannes@civico.de. Security reports:
security@civico.de, see [SECURITY.md](SECURITY.md).
