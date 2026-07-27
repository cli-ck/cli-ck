#!/usr/bin/env node
// Bumps the app version consistently across every manifest that carries
// one, so a release never leaves one of them stale (real incident: the
// Settings "Build" field's platform-detection code carried a hand-typed
// version string that drifted stale across several real releases, since
// nothing kept it in sync - see AboutSection.tsx's fix in the same
// change that introduced this script). Cargo.lock's own `oz` entry is
// regenerated afterward via `cargo check`, not hand-edited, since it must
// stay exactly consistent with Cargo.toml for CI's `--locked` builds to
// accept it.
//
// Usage: node scripts/bump-version.mjs 0.2.5
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("usage: node scripts/bump-version.mjs <major.minor.patch>");
  console.error('example: node scripts/bump-version.mjs 0.2.5');
  process.exit(1);
}

function replaceOnce(filePath, pattern, replacement, label) {
  const full = path.join(repoRoot, filePath);
  const contents = readFileSync(full, "utf8");
  if (!pattern.test(contents)) {
    throw new Error(`${filePath}: pattern for ${label} not found - manifest shape changed?`);
  }
  const updated = contents.replace(pattern, replacement);
  writeFileSync(full, updated);
  console.log(`updated ${filePath}`);
}

replaceOnce(
  "package.json",
  /"version":\s*"[^"]+"/,
  `"version": "${version}"`,
  "package.json version",
);

replaceOnce(
  "npm-wrapper/package.json",
  /"version":\s*"[^"]+"/,
  `"version": "${version}"`,
  "npm-wrapper version",
);

replaceOnce(
  "src-tauri/tauri.conf.json",
  /"version":\s*"[^"]+"/,
  `"version": "${version}"`,
  "tauri.conf.json version",
);

replaceOnce(
  "src-tauri/Cargo.toml",
  /^version = "[^"]+"/m,
  `version = "${version}"`,
  "Cargo.toml [package] version",
);

console.log("regenerating Cargo.lock's own `oz` entry (cargo check, not --locked)...");
execFileSync("cargo", ["check", "--quiet"], {
  cwd: path.join(repoRoot, "src-tauri"),
  stdio: "inherit",
});

console.log(`\nDone. Now review the diff (especially src-tauri/Cargo.lock - it should` +
  ` only touch the "oz" package's own version, nothing else), update CHANGELOG.md` +
  ` if you haven't already, and commit as "chore(release): v${version}".`);
