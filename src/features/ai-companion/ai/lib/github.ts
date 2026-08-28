import { proxyFetch } from "./proxyFetch";

export type GithubComment = { author: string; body: string };
export type GithubIssue = {
  title: string;
  body: string;
  comments: GithubComment[];
};

const MAX_BODY_CHARS = 4000;
const MAX_COMMENTS = 5;
const ISSUE_URL_RE = /github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)/;

export function parseGithubIssueUrl(
  text: string,
): { owner: string; repo: string; number: number } | null {
  const m = text.match(ISSUE_URL_RE);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

async function ghJson<T>(url: string): Promise<T> {
  const res = await proxyFetch(url, {
    headers: {
      "User-Agent": "cli-ck",
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  return res.json() as Promise<T>;
}

/** Fetches an issue's title/body plus its most recent comments (unauthenticated,
 *  public repos only — 60 req/hr GitHub rate limit). */
export async function fetchGithubIssue(
  owner: string,
  repo: string,
  number: number,
): Promise<GithubIssue> {
  const issue = await ghJson<{
    title: string;
    body: string | null;
    comments: number;
  }>(`https://api.github.com/repos/${owner}/${repo}/issues/${number}`);

  let rawComments: { user: { login: string }; body: string | null }[] = [];
  if (issue.comments > 0) {
    // Comments come back oldest-first; request the last page to get the
    // most recent MAX_COMMENTS instead of the oldest ones.
    const lastPage = Math.max(1, Math.ceil(issue.comments / MAX_COMMENTS));
    rawComments = await ghJson(
      `https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments?per_page=${MAX_COMMENTS}&page=${lastPage}`,
    );
  }

  return {
    title: issue.title,
    body: truncate(issue.body ?? "", MAX_BODY_CHARS),
    comments: rawComments.map((c) => ({
      author: c.user.login,
      body: truncate(c.body ?? "", MAX_BODY_CHARS),
    })),
  };
}

export function formatIssueContext(issue: GithubIssue): string {
  const parts = [`## Linked GitHub issue: ${issue.title}`, issue.body];
  if (issue.comments.length > 0) {
    parts.push(
      "### Recent comments",
      issue.comments.map((c) => `- **${c.author}**: ${c.body}`).join("\n"),
    );
  }
  return parts.join("\n\n");
}
