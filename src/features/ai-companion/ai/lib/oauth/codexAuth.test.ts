import { describe, expect, it } from "vitest";
import { extractAccountId, parseJwtClaims } from "./codexAuth";

function fakeJwt(claims: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: "none" }));
  const payload = btoa(JSON.stringify(claims));
  return `${header}.${payload}.`;
}

describe("parseJwtClaims", () => {
  it("decodes the payload segment", () => {
    const token = fakeJwt({ chatgpt_account_id: "acct_1" });
    expect(parseJwtClaims(token)).toEqual({ chatgpt_account_id: "acct_1" });
  });

  it("returns undefined for a malformed token", () => {
    expect(parseJwtClaims("not-a-jwt")).toBeUndefined();
    expect(parseJwtClaims("a.b")).toBeUndefined();
  });
});

describe("extractAccountId", () => {
  it("prefers the top-level chatgpt_account_id claim", () => {
    const id_token = fakeJwt({ chatgpt_account_id: "acct_top" });
    expect(extractAccountId({ id_token })).toBe("acct_top");
  });

  it("falls back to the nested auth-namespace claim", () => {
    const id_token = fakeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_nested" },
    });
    expect(extractAccountId({ id_token })).toBe("acct_nested");
  });

  it("falls back to the first organization id", () => {
    const id_token = fakeJwt({ organizations: [{ id: "org_1" }] });
    expect(extractAccountId({ id_token })).toBe("org_1");
  });

  it("falls back to the access token when there is no id_token", () => {
    const access_token = fakeJwt({ chatgpt_account_id: "acct_from_access" });
    expect(extractAccountId({ access_token })).toBe("acct_from_access");
  });

  it("returns undefined when neither token carries an account id", () => {
    expect(extractAccountId({ id_token: fakeJwt({}) })).toBeUndefined();
  });
});
