# Sidecar binaries

This directory holds the `cli-ck-code-intel` sidecar Tauri bundles per
platform (`bundle.externalBin` in `tauri.conf.json`), named per Tauri's
sidecar convention: `cli-ck-code-intel-<target-triple>[.exe]`.

Nothing in this directory is committed (see `.gitignore`) - these are build
artifacts, not source, and are produced by a separate repo
(`cli-ck/cli-ck-code-intel`) with its own release cadence.

CI and release workflows run `scripts/fetch-code-intel-sidecar.mjs`, which
downloads the pinned `v0.1.0` release asset from the private
`cli-ck/cli-ck-code-intel` repository and verifies its SHA-256 digest against
that release's `checksums.txt`. Configure `CODE_INTEL_RELEASE_TOKEN` as a
fine-grained GitHub secret with read-only `contents` access to that repository.

For local Tauri development, build the helper from a checkout of that repo
and copy it in under your machine's target triple, e.g. on Apple Silicon:

```bash
cd ../cli-ck-code-intel
cargo build --release -p helper-bin
cp target/release/cli-ck-code-intel \
  ../cli-ck/src-tauri/binaries/cli-ck-code-intel-aarch64-apple-darwin
```

(Run `rustc -vV | grep host` to get your own target triple.)

The copied binary is ignored by Git. In CI and release builds, it is always
replaced with the verified release asset; cli-ck never builds Code Intel from
source as part of its own release.
