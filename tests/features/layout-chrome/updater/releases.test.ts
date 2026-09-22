import { describe, expect, it } from "vitest";
import { selectBetaRelease } from "@/features/layout-chrome/updater/releases";

const releases = [
  {
    tag_name: "v0.3.0-beta",
    body: "Beta fixes.",
    html_url: "https://github.com/cli-ck/cli-ck/releases/tag/v0.3.0-beta",
    draft: false,
    assets: [
      {
        name: "cli-ck_0.3.0_aarch64.dmg",
        browser_download_url: "https://downloads.example/macos-arm.dmg",
      },
      {
        name: "cli-ck_0.3.0_x64.dmg",
        browser_download_url: "https://downloads.example/macos-x64.dmg",
      },
      {
        name: "cli-ck_0.3.0_x64-setup.exe",
        browser_download_url: "https://downloads.example/windows.exe",
      },
      {
        name: "cli-ck_0.3.0_amd64.AppImage",
        browser_download_url: "https://downloads.example/linux.AppImage",
      },
    ],
  },
];

describe("selectBetaRelease", () => {
  it("selects the matching beta installer for the current platform", () => {
    expect(
      selectBetaRelease(releases, "0.2.6", "macos", "aarch64"),
    ).toMatchObject({
      version: "0.3.0-beta",
      downloadUrl: "https://downloads.example/macos-arm.dmg",
    });
    expect(
      selectBetaRelease(releases, "0.2.6", "windows", "x86_64"),
    ).toMatchObject({
      downloadUrl: "https://downloads.example/windows.exe",
    });
  });

  it("does not offer an equal-or-older beta", () => {
    expect(selectBetaRelease(releases, "0.3.0", "macos", "aarch64")).toBeNull();
  });
});
