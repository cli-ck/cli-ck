import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const require = createRequire(import.meta.url);
const artifacts = require(
  path.join(repoRoot, "npm-wrapper/lib/release-artifacts.js"),
) as {
  REPO: string;
  PRODUCT: string;
  artifactName: (opts: {
    platform: string;
    arch: string;
    version: string;
  }) => string;
  binaryRelPath: (platform: string) => string;
  downloadUrl: (opts: {
    repo: string;
    version: string;
    artifact: string;
  }) => string;
};

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), "utf8");
}

describe("npm launcher release artifacts", () => {
  it("downloads cli-ck binaries from the cli-ck GitHub repo", () => {
    expect(artifacts.REPO).toBe("cli-ck/cli-ck");
    expect(artifacts.PRODUCT).toBe("cli-ck");
    expect(
      artifacts.artifactName({
        platform: "darwin",
        arch: "arm64",
        version: "0.2.6",
      }),
    ).toBe("cli-ck_0.2.6_aarch64.app.tar.gz");
    expect(
      artifacts.artifactName({
        platform: "linux",
        arch: "x64",
        version: "0.2.6",
      }),
    ).toBe("cli-ck_linux_x64.zip");
    expect(
      artifacts.artifactName({
        platform: "win32",
        arch: "x64",
        version: "0.2.6",
      }),
    ).toBe("cli-ck_windows_x64.zip");
    expect(artifacts.binaryRelPath("darwin")).toBe(
      "cli-ck.app/Contents/MacOS/cli-ck",
    );
    expect(
      artifacts.downloadUrl({
        repo: artifacts.REPO,
        version: "0.2.6",
        artifact: "cli-ck_0.2.6_aarch64.app.tar.gz",
      }),
    ).toBe(
      "https://github.com/cli-ck/cli-ck/releases/download/v0.2.6/cli-ck_0.2.6_aarch64.app.tar.gz",
    );
  });

  it("does not leave Oz artifact names in the launcher or release workflow", () => {
    const launcher = read("npm-wrapper/bin/cli-ck.js");
    const workflow = read(".github/workflows/release.yml");
    const artifacts = read("npm-wrapper/lib/release-artifacts.js");
    for (const source of [launcher, workflow, artifacts]) {
      expect(source).not.toMatch(/oz_linux_x64\.zip/);
      expect(source).not.toMatch(/oz_windows_x64\.zip/);
      expect(source).not.toMatch(/Oz_\$\{VERSION\}/);
      expect(source).not.toMatch(/Oz_\$\{version\}/);
    }
  });
});
