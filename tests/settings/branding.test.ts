import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  APP_DISPLAY_NAME,
  BUNDLE_ID,
  REPO_SLUG,
  REPO_URL,
  WEBSITE_URL,
} from "@/settings/branding";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

describe("product branding", () => {
  it("matches tauri.conf.json and does not point at Oz", () => {
    const conf = JSON.parse(
      readFileSync(path.join(repoRoot, "src-tauri/tauri.conf.json"), "utf8"),
    ) as { productName: string; identifier: string };
    expect(conf.productName).toBe(APP_DISPLAY_NAME);
    expect(conf.identifier).toBe(BUNDLE_ID);
    expect(REPO_SLUG).toBe("cli-ck/cli-ck");
    expect(REPO_URL).toContain("cli-ck/cli-ck");
    expect(WEBSITE_URL).toContain("cli-ck-website");
    expect(JSON.stringify({ BUNDLE_ID, REPO_URL, WEBSITE_URL })).not.toMatch(
      /oz/i,
    );
  });
});
