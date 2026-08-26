import { openUrl } from "@tauri-apps/plugin-opener";
import { setKey } from "../keyring";
import { waitForOAuthCallback } from "./callbackListener";
import { generatePkce } from "./pkce";

// Arbitrary local port for the loopback callback. OpenRouter's callback_url
// accepts any address, so this doesn't need to match a value registered
// with OpenRouter (unlike Codex's fixed 1455, which does).
const CALLBACK_PORT = 51703;
const CALLBACK_PATH = "/callback";

/** OpenRouter's own OAuth PKCE login (https://openrouter.ai/docs/use-cases/oauth-pkce).
 *  The exchange returns a normal, user-controlled OpenRouter API key, so once
 *  this resolves the connection is stored exactly like a pasted key — no
 *  separate OAuth credential type needed for this provider. */
export async function loginWithOpenRouter(): Promise<void> {
  const pkce = await generatePkce();
  const callbackUrl = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;

  const authorizeUrl = new URL("https://openrouter.ai/auth");
  authorizeUrl.searchParams.set("callback_url", callbackUrl);
  authorizeUrl.searchParams.set("code_challenge", pkce.challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  // Start listening before opening the browser so the redirect can never
  // arrive before something is bound to catch it.
  const callback = waitForOAuthCallback(CALLBACK_PORT);
  await openUrl(authorizeUrl.toString());

  const params = await callback;
  if (params.error) {
    throw new Error(params.error_description || params.error);
  }
  const code = params.code;
  if (!code)
    throw new Error("OpenRouter did not return an authorization code.");

  const res = await fetch("https://openrouter.ai/api/v1/auth/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      code_verifier: pkce.verifier,
      code_challenge_method: "S256",
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenRouter key exchange failed: ${res.status}`);
  }
  const data = (await res.json()) as { key?: string };
  if (!data.key) throw new Error("OpenRouter did not return an API key.");

  await setKey("openrouter", data.key);
}
