import { describe, expect, it } from "vitest";
import {
  formatIssueContext,
  parseGithubIssueUrl,
} from "@/features/ai-companion/ai/lib/github";

describe("parseGithubIssueUrl", () => {
  it("matches a full https url embedded in surrounding text", () => {
    expect(
      parseGithubIssueUrl(
        "please look at https://github.com/cli-ck/cli-ck/issues/42 thanks",
      ),
    ).toEqual({ owner: "cli-ck", repo: "cli-ck", number: 42 });
  });

  it("matches a bare github.com url with no scheme", () => {
    expect(parseGithubIssueUrl("github.com/foo/bar/issues/7")).toEqual({
      owner: "foo",
      repo: "bar",
      number: 7,
    });
  });

  it("returns null when no issue url is present", () => {
    expect(parseGithubIssueUrl("just a normal message, no links here")).toBe(
      null,
    );
  });

  it("returns null for a github url that isn't an issue link", () => {
    expect(parseGithubIssueUrl("https://github.com/cli-ck/cli-ck")).toBe(null);
  });
});

describe("formatIssueContext", () => {
  it("formats title, body, and comments", () => {
    const out = formatIssueContext({
      title: "Bug: thing is broken",
      body: "Steps to reproduce...",
      comments: [{ author: "alice", body: "confirmed on my machine" }],
    });
    expect(out).toContain("## Linked GitHub issue: Bug: thing is broken");
    expect(out).toContain("Steps to reproduce...");
    expect(out).toContain("### Recent comments");
    expect(out).toContain("- **alice**: confirmed on my machine");
  });

  it("omits the comments section when there are none", () => {
    const out = formatIssueContext({
      title: "No comments yet",
      body: "body text",
      comments: [],
    });
    expect(out).not.toContain("### Recent comments");
  });
});
