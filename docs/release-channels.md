# Release channels

Every release starts with one or two finished features and a passing CI run.
The tag is the release instruction. Its version must match `package.json`,
`src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` exactly.

Before creating any alpha, beta, or stable tag, add a user-facing release note
at `docs/release-notes/vX.Y.Z*.md`. The workflow refuses to publish without
that file and uses it as the GitHub release description.

## Alpha

Use numbered alpha tags while the feature work is internal:

```sh
git tag v0.3.0-alpha-1
git push origin v0.3.0-alpha-1
```

The next alpha is `v0.3.0-alpha-2`. The workflow builds all desktop
installers and publishes an invited-customer GitHub pre-release. Alpha tags do
not publish to npm or Nix, and the built-in updater remains on the last stable
release.

## Beta

When the feature is ready for invited beta developers and testers, tag the
same release line as `v0.3.0-beta`:

```sh
git tag v0.3.0-beta
git push origin v0.3.0-beta
```

The workflow builds all desktop installers and publishes one GitHub
pre-release. The website should list this published pre-release for beta
participants. The normal updater endpoint, npm `latest`, and Nix stay on the
last stable release.

## Stable

After enough positive beta feedback, use the plain version tag:

```sh
git tag v0.3.0
git push origin v0.3.0
```

The workflow publishes the stable GitHub release, the npm wrapper under
`latest`, and the Nix source update. The built-in updater then sees this
release through GitHub's `releases/latest` endpoint.
