#!/usr/bin/env bash
# Tauri's build script validates that every `bundle.externalBin` entry
# resolves to a real file on disk for the current target triple - even
# during a plain `cargo check`, not just a real `tauri build`. CI has no
# way to obtain the real oz-code-intel sidecar binary yet (that supply
# chain - either building codecollab-co/oz-code-intel from source or
# fetching its own release artifact - doesn't exist yet), so this writes
# a harmless placeholder file just so that validation passes.
#
# This is NOT a working sidecar. It's safe only because the real
# oz_code_intel module is not yet wired into any AI-facing tool or UI -
# nothing currently shipped ever actually spawns this binary. Once the
# real supply chain exists, replace calls to this script with a real
# fetch/build step instead of deleting it outright, since local dev
# without a locally-built binary (see binaries/README.md) still needs it.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

triple="$(rustc -vV | sed -n 's/^host: //p')"
suffix=""
case "$triple" in
  *windows*) suffix=".exe" ;;
esac

bin_path="binaries/oz-code-intel-${triple}${suffix}"

if [ -f "$bin_path" ]; then
  echo "using existing binaries/$(basename "$bin_path") (real or already-stubbed)"
  exit 0
fi

mkdir -p binaries
echo "not a real binary - see src-tauri/scripts/ensure-code-intel-sidecar-stub.sh" > "$bin_path"
chmod +x "$bin_path"
echo "wrote a placeholder at $bin_path (no real oz-code-intel sidecar available in this environment)"
