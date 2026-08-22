// @vitest-environment happy-dom

import { AboutSection } from "@/settings/sections/AboutSection";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/app", () => ({
  getName: () => Promise.resolve("Oz"),
  getVersion: () => Promise.resolve("0.2.5"),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
}));

vi.mock("@tauri-apps/plugin-os", () => ({
  platform: () => "macos",
  arch: () => "aarch64",
}));

vi.mock("@/features/layout-chrome/updater", () => ({
  useUpdater: () => ({
    status: { kind: "idle" },
    check: vi.fn(),
    install: vi.fn(),
  }),
}));

beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

afterEach(cleanup);

describe("AboutSection branding", () => {
  it("shows cli-ck identity even if the native getName() still returns Oz", async () => {
    render(<AboutSection />);

    expect(await screen.findByText("cli-ck")).toBeTruthy();
    expect(screen.getByText("app.cli-ck.cli-ck")).toBeTruthy();
    expect(screen.getByText("cli-ck/cli-ck")).toBeTruthy();
    expect(screen.getByText("cli-ck.github.io/cli-ck-website")).toBeTruthy();

    expect(screen.queryByText("Oz")).toBeNull();
    expect(screen.queryByText(/codecollab-co\/oz/)).toBeNull();
    expect(screen.queryByText(/app\.codecollab-co\.oz/)).toBeNull();
    expect(screen.queryByText(/oz-website/)).toBeNull();
  });
});
