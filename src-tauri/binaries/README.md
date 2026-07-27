# Sidecar binaries

This directory holds the `oz-code-intel` sidecar binary Tauri bundles per
platform (`bundle.externalBin` in `tauri.conf.json`), named per Tauri's
sidecar convention: `oz-code-intel-<target-triple>[.exe]`.

Nothing in this directory is committed (see `.gitignore`) - these are build
artifacts, not source, and are produced by a separate repo
(`codecollab-co/oz-code-intel`) with its own release cadence.

**For local development**, build the helper from a checkout of that repo and
copy it in under your machine's target triple, e.g. on Apple Silicon:

```bash
cd ../oz-code-intel
cargo build --release -p helper-bin
cp target/release/oz-code-intel \
  ../oz/src-tauri/binaries/oz-code-intel-aarch64-apple-darwin
```

(Run `rustc -vV | grep host` to get your own target triple.)

**In CI / for a real release**, this will instead download the matching
per-platform artifact from `oz-code-intel`'s own GitHub Releases once that
repo has actually published one (see its `ROADMAP.md` Slice 25) - not built
here.
