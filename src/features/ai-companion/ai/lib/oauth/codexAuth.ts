import { invoke } from "@tauri-apps/api/core";
import { KEYRING_SERVICE } from "../../config";

// The public client id the official Codex CLI itself registers under.
// There is no secret here, PKCE is what actually authenticates the flow.
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

const AUTH_ACCOUNT = "openai-codex-oauth";
const AUTH_METHOD_ACCOUNT_PREFIX = "auth-method-";

export type CodexAuth = {
  access: string;
  refresh: string;
  /** epoch ms */
  expires: number;
  accountId?: string;
};

export async function getCodexAuth(): Promise<CodexAuth | null> {
  try {
    const raw = await invoke<string | null>("secrets_get", {
      service: KEYRING_SERVICE,
      account: AUTH_ACCOUNT,
    });
    return raw ? (JSON.parse(raw) as CodexAuth) : null;
  } catch {
    return null;
  }
}

export async function setCodexAuth(auth: CodexAuth): Promise<void> {
  await invoke("secrets_set", {
    service: KEYRING_SERVICE,
    account: AUTH_ACCOUNT,
    password: JSON.stringify(auth),
  });
}

export async function clearCodexAuth(): Promise<void> {
  try {
    await invoke("secrets_delete", {
      service: KEYRING_SERVICE,
      account: AUTH_ACCOUNT,
    });
  } catch {
    // already absent, fine
  }
}

/** Whether to use a subscription login or a pasted API key for a provider.
 *  Stored per-provider. `defaultMethod` is what applies before the person
 *  has ever chosen: Codex logins are already an explicit action, so "oauth"
 *  is fine, but Claude CLI is auto-detected off PATH, so it needs "apikey"
 *  as the default, otherwise merely having the CLI installed would silently
 *  opt someone in who never asked cli-ck to use it. */
export async function getPreferredAuthMethod(
  providerId: string,
  defaultMethod: "apikey" | "oauth" = "oauth",
): Promise<"apikey" | "oauth"> {
  try {
    const raw = await invoke<string | null>("secrets_get", {
      service: KEYRING_SERVICE,
      account: `${AUTH_METHOD_ACCOUNT_PREFIX}${providerId}`,
    });
    if (raw === "apikey" || raw === "oauth") return raw;
    return defaultMethod;
  } catch {
    return defaultMethod;
  }
}

export async function setPreferredAuthMethod(
  providerId: string,
  method: "apikey" | "oauth",
): Promise<void> {
  await invoke("secrets_set", {
    service: KEYRING_SERVICE,
    account: `${AUTH_METHOD_ACCOUNT_PREFIX}${providerId}`,
    password: method,
  });
}

function base64UrlDecode(segment: string): string {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  return atob(padded);
}

type JwtClaims = {
  chatgpt_account_id?: string;
  organizations?: Array<{ id: string }>;
  "https://api.openai.com/auth"?: { chatgpt_account_id?: string };
};

export function parseJwtClaims(token: string): JwtClaims | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(base64UrlDecode(parts[1])) as JwtClaims;
  } catch {
    return undefined;
  }
}

function accountIdFromClaims(claims: JwtClaims | undefined): string | undefined {
  return (
    claims?.chatgpt_account_id ||
    claims?.["https://api.openai.com/auth"]?.chatgpt_account_id ||
    claims?.organizations?.[0]?.id
  );
}

export function extractAccountId(tokens: {
  id_token?: string;
  access_token?: string;
}): string | undefined {
  return (
    accountIdFromClaims(parseJwtClaims(tokens.id_token ?? "")) ??
    accountIdFromClaims(parseJwtClaims(tokens.access_token ?? ""))
  );
}

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expires_in?: number;
};

async function refreshCodexAuth(auth: CodexAuth): Promise<CodexAuth> {
  const res = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: auth.refresh,
      client_id: CLIENT_ID,
    }),
  });
  if (!res.ok) throw new Error(`Codex token refresh failed: ${res.status}`);
  const tokens = (await res.json()) as TokenResponse;
  const next: CodexAuth = {
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    accountId: extractAccountId(tokens) ?? auth.accountId,
  };
  await setCodexAuth(next);
  return next;
}

const EXPIRY_SAFETY_MARGIN_MS = 5_000;

/** Returns a live access token, refreshing and persisting first if the
 *  stored one has expired. Null when there's no Codex login at all. */
export async function getFreshCodexAccessToken(): Promise<{
  access: string;
  accountId?: string;
} | null> {
  const auth = await getCodexAuth();
  if (!auth) return null;
  if (auth.expires > Date.now() + EXPIRY_SAFETY_MARGIN_MS) {
    return { access: auth.access, accountId: auth.accountId };
  }
  const refreshed = await refreshCodexAuth(auth);
  return { access: refreshed.access, accountId: refreshed.accountId };
}

/** A `fetch` that turns any OpenAI-shaped request into an authenticated
 *  Codex request: strips whatever Authorization the AI SDK set (it only
 *  knows the placeholder apiKey), attaches the real bearer token and
 *  account id, and redirects chat/responses calls to the Codex backend
 *  endpoint, mirroring what the official Codex CLI itself talks to. */
export function createCodexFetch(): typeof fetch {
  return async (input, init) => {
    const fresh = await getFreshCodexAccessToken();
    if (!fresh) {
      throw new Error("Not logged in to Codex. Reconnect in Settings > Models.");
    }

    const headers = new Headers(init?.headers);
    headers.delete("authorization");
    headers.set("Authorization", `Bearer ${fresh.access}`);
    if (fresh.accountId) headers.set("ChatGPT-Account-Id", fresh.accountId);
    headers.set("originator", "cli-ck");

    const requestUrl =
      input instanceof URL
        ? input
        : new URL(typeof input === "string" ? input : input.url);
    const rewrite =
      requestUrl.pathname.includes("/responses") ||
      requestUrl.pathname.includes("/chat/completions");
    const url = rewrite ? CODEX_API_ENDPOINT : requestUrl;

    return fetch(url, { ...init, headers });
  };
}
