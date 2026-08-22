import {
  extractProtectedFiles,
  mergeProtectedFiles,
} from "@/features/ai-companion/ai/lib/aiAgent";
import { describe, expect, it } from "vitest";

describe("extractProtectedFiles", () => {
  it("picks up a 'do not touch' instruction", () => {
    expect(
      extractProtectedFiles("do not change migrations.sql, add the index elsewhere"),
    ).toEqual(new Set(["migrations.sql"]));
  });

  it("returns empty for prompts with no such instruction", () => {
    expect(extractProtectedFiles("refactor the auth module")).toEqual(new Set());
  });
});

describe("mergeProtectedFiles", () => {
  it("returns the derived set unchanged when nothing was inherited", () => {
    const derived = new Set(["a.ts"]);
    expect(mergeProtectedFiles(undefined, derived)).toBe(derived);
  });

  it("unions inherited and derived rather than replacing", () => {
    const inherited = new Set(["a.ts"]);
    const derived = new Set(["b.ts"]);
    expect(mergeProtectedFiles(inherited, derived)).toEqual(
      new Set(["a.ts", "b.ts"]),
    );
  });

  it("still protects an inherited file even if this turn's prompt mentions none", () => {
    const inherited = new Set(["secrets.env"]);
    expect(mergeProtectedFiles(inherited, new Set())).toEqual(
      new Set(["secrets.env"]),
    );
  });
});
