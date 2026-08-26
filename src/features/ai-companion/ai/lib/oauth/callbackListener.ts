import { invoke } from "@tauri-apps/api/core";

/** Waits for the browser to redirect back to a local port after an OAuth
 *  login, and returns the redirect's query params. Backed by the shared
 *  `oauth_loopback_listen` Rust command (src-tauri/src/modules/oauth.rs),
 *  which binds the port, accepts one connection, and hands back its raw
 *  path+query string. */
export async function waitForOAuthCallback(
  port: number,
  timeoutSecs = 300,
): Promise<Record<string, string>> {
  const pathAndQuery = await invoke<string>("oauth_loopback_listen", {
    port,
    timeoutSecs,
  });
  const url = new URL(`http://127.0.0.1${pathAndQuery}`);
  return Object.fromEntries(url.searchParams.entries());
}
