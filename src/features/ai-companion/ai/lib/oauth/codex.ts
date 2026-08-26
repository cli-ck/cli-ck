import { openUrl } from "@tauri-apps/plugin-opener";
import { extractAccountId, setCodexAuth } from "./codexAuth";
import { waitForOAuthCallback } from "./callbackListener";
import { generatePkce, randomState } from "./pkce";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
// Fixed, this exact port and path are what the client id above is
// registered with on OpenAI's side, unlike OpenRouter's arbitrary callback.
const CALLBACK_PORT = 1455;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/auth/callback`;

function buildAuthorizeUrl(challenge: string, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "openid profile email offline_access",
    code_challenge: challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "cli-ck",
  });
  return `${ISSUER}/oauth/authorize?${params}`;
}

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expires_in?: number;
};

/** OpenAI's Codex/ChatGPT login, the same OAuth client the official Codex
 *  CLI uses. Unlike OpenRouter this returns a short-lived access token plus
 *  a refresh token rather than a plain API key, so it is stored and kept
 *  fresh separately (see codexAuth.ts) instead of through the regular
 *  keyring key slot. */
export async function loginWithCodex(): Promise<void> {
  const pkce = await generatePkce();
  const state = randomState();
  const authorizeUrl = buildAuthorizeUrl(pkce.challenge, state);

  // Bind the listener before opening the browser so the redirect can't
  // arrive before anything is there to catch it.
  const callback = waitForOAuthCallback(CALLBACK_PORT);
  await openUrl(authorizeUrl);
  const params = await callback;

  if (params.error) {
    throw new Error(params.error_description || params.error);
  }
  if (params.state !== state) {
    throw new Error("Codex login failed: unexpected response, try again.");
  }
  const code = params.code;
  if (!code) throw new Error("Codex did not return an authorization code.");

  const res = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: pkce.verifier,
    }),
  });
  if (!res.ok) throw new Error(`Codex login failed: ${res.status}`);
  const tokens = (await res.json()) as TokenResponse;

  await setCodexAuth({
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    accountId: extractAccountId(tokens),
  });
}
