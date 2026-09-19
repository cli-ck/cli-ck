import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";

const tag = process.env.CODE_INTEL_RELEASE_TAG ?? "v0.1.0";
const target = process.env.CODE_INTEL_TARGET;
const knownTargets = new Set([
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "x86_64-unknown-linux-gnu",
]);

if (!target || !knownTargets.has(target)) {
  throw new Error(`CODE_INTEL_TARGET must be one of: ${[...knownTargets].join(", ")}`);
}

const extension = target.includes("windows") ? ".exe" : "";
const asset = `cli-ck-code-intel-${target}${extension}`;
const destinationDir = join(process.cwd(), "src-tauri", "binaries");
const tempDir = join(tmpdir(), `cli-ck-code-intel-${process.pid}`);
const authToken = process.env.CODE_INTEL_RELEASE_TOKEN ?? process.env.GH_TOKEN;

function download(pattern) {
  const result = spawnSync(
    "gh",
    [
      "release",
      "download",
      tag,
      "--repo",
      "cli-ck/cli-ck-code-intel",
      "--pattern",
      pattern,
      "--dir",
      tempDir,
    ],
    {
      stdio: "inherit",
      env: { ...process.env, ...(authToken ? { GH_TOKEN: authToken } : {}) },
    },
  );
  if (result.status !== 0) throw new Error(`failed to download ${pattern} from ${tag}`);
}

try {
  await mkdir(tempDir, { recursive: true });
  download(asset);
  download("checksums.txt");

  const expected = new Map(
    (await readFile(join(tempDir, "checksums.txt"), "utf8"))
      .split("\n")
      .map((line) => line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/))
      .filter((match) => match)
      .map((match) => [basename(match[2]), match[1].toLowerCase()]),
  );
  const source = join(tempDir, asset);
  const actual = createHash("sha256").update(await readFile(source)).digest("hex");
  if (actual !== expected.get(asset)) {
    throw new Error(`checksum mismatch for ${asset}`);
  }

  await mkdir(destinationDir, { recursive: true });
  await copyFile(source, join(destinationDir, asset));
  if (!extension) await chmod(join(destinationDir, asset), 0o755);
  console.log(`Verified and staged ${asset} from Code Intel ${tag}.`);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
