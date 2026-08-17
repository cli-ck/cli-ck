# Sidecar binaries

**Not currently wired up.** `tauri.conf.json` has no `bundle.externalBin`
entry yet - see `src/modules/code_intel/mod.rs`'s doc comment for why (in
short: that would require a real per-platform binary to exist at build
time for every platform this app ships, which needs either
`cli-ck-code-intel`'s own release pipeline to have fired for real, or a
cross-repo build step - neither exists yet). This directory and the
instructions below describe the *intended future* layout, for whenever
that's wired back up.

This directory would hold the `cli-ck-code-intel` sidecar binary Tauri bundles
per platform (`bundle.externalBin` in `tauri.conf.json`), named per Tauri's
sidecar convention: `cli-ck-code-intel-<target-triple>[.exe]`.

Nothing in this directory is committed (see `.gitignore`) - these are build
artifacts, not source, and are produced by a separate repo
(`cli-ck/cli-ck-code-intel`) with its own release cadence.

**Once `bundle.externalBin` is restored** (not yet - see above), local
development would mean building the helper from a checkout of that repo
and copying it in under your machine's target triple, e.g. on Apple
Silicon:

```bash
cd ../cli-ck-code-intel
cargo build --release -p helper-bin
cp target/release/cli-ck-code-intel \
  ../cli-ck/src-tauri/binaries/cli-ck-code-intel-aarch64-apple-darwin
```

(Run `rustc -vV | grep host` to get your own target triple.)

Doing this today, with `externalBin` still absent, doesn't make the
sidecar spawnable - `app.shell().sidecar(...)` looks it up via the Tauri
config, not just by checking this directory, so `CodeIntelSession::spawn`
will still return "sidecar not registered" regardless. Restore the
`tauri.conf.json` entry and the matching `shell:allow-execute` capability
first.

**In CI / for a real release**, once that's restored, this will instead
download the matching per-platform artifact from `cli-ck-code-intel`'s own
GitHub Releases once that repo has actually published one (see its
`ROADMAP.md` Slice 25) - not built here.
