//! Minimal loopback HTTP listener for OAuth PKCE browser callbacks.
//!
//! Binds to 127.0.0.1:port (port 0 = OS picks a free one), reports the bound
//! port back over the channel so the caller can build the authorize URL,
//! accepts exactly one connection, parses the redirect's query string, and
//! reports it back too. Shared by every provider's browser-based login flow
//! (OpenRouter, Codex) — the PKCE/token-exchange logic itself lives in TS.

use std::collections::HashMap;

use tauri::ipc::Channel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::time::{timeout, Duration};

const RESPONSE_BODY: &str = "<!doctype html><html><body style=\"font-family:-apple-system,sans-serif;text-align:center;padding:4rem\"><h2>You're connected</h2><p>You can close this tab and go back to cli-ck.</p></body></html>";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OAuthListenEvent {
    Listening { port: u16 },
    Callback { params: HashMap<String, String> },
    Error { message: String },
}

fn parse_query(path_and_query: &str) -> HashMap<String, String> {
    // No real host/scheme involved — this only exists to borrow reqwest's
    // (already a dependency) URL query-pair decoder instead of hand-rolling one.
    let dummy = format!("http://localhost{path_and_query}");
    match reqwest::Url::parse(&dummy) {
        Ok(url) => url
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect(),
        Err(_) => HashMap::new(),
    }
}

#[tauri::command]
pub async fn oauth_listen(
    port: u16,
    path: String,
    timeout_secs: u64,
    on_event: Channel<OAuthListenEvent>,
) -> Result<(), String> {
    let listener = match TcpListener::bind(("127.0.0.1", port)).await {
        Ok(l) => l,
        Err(e) => {
            let message = format!("could not listen on 127.0.0.1:{port}: {e}");
            let _ = on_event.send(OAuthListenEvent::Error {
                message: message.clone(),
            });
            return Err(message);
        }
    };
    let bound_port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let _ = on_event.send(OAuthListenEvent::Listening { port: bound_port });

    let accepted = timeout(Duration::from_secs(timeout_secs), listener.accept()).await;
    let (mut socket, _) = match accepted {
        Ok(Ok(pair)) => pair,
        Ok(Err(e)) => {
            let _ = on_event.send(OAuthListenEvent::Error {
                message: e.to_string(),
            });
            return Err(e.to_string());
        }
        Err(_) => {
            let message = "timed out waiting for the browser to redirect back".to_string();
            let _ = on_event.send(OAuthListenEvent::Error {
                message: message.clone(),
            });
            return Err(message);
        }
    };

    let mut buf = vec![0u8; 8192];
    let n = match socket.read(&mut buf).await {
        Ok(n) => n,
        Err(e) => {
            let _ = on_event.send(OAuthListenEvent::Error {
                message: e.to_string(),
            });
            return Err(e.to_string());
        }
    };
    let request = String::from_utf8_lossy(&buf[..n]);
    let request_line = request.lines().next().unwrap_or("");
    // Expected shape: "GET {path}?code=...&state=... HTTP/1.1"
    let path_and_query = request_line
        .split_whitespace()
        .nth(1)
        .filter(|s| !s.is_empty());

    let Some(path_and_query) = path_and_query else {
        let message = "malformed callback request".to_string();
        let _ = on_event.send(OAuthListenEvent::Error {
            message: message.clone(),
        });
        return Err(message);
    };
    // Anything on this loopback port before the browser redirect arrives
    // (a stray probe, a browser prefetch of some other path) should not be
    // mistaken for the real callback.
    let request_path = path_and_query.split('?').next().unwrap_or("");
    if request_path != path {
        let message = format!("unexpected callback path: {request_path}");
        let _ = on_event.send(OAuthListenEvent::Error {
            message: message.clone(),
        });
        return Err(message);
    }

    let params = parse_query(path_and_query);

    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        RESPONSE_BODY.len(),
        RESPONSE_BODY
    );
    let _ = socket.write_all(response.as_bytes()).await;
    let _ = socket.shutdown().await;

    let _ = on_event.send(OAuthListenEvent::Callback { params });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_code_and_state_from_the_redirect_path() {
        let params = parse_query("/callback?code=abc%20123&state=xyz");
        assert_eq!(params.get("code"), Some(&"abc 123".to_string()));
        assert_eq!(params.get("state"), Some(&"xyz".to_string()));
    }

    #[test]
    fn empty_query_yields_empty_map() {
        assert!(parse_query("/callback").is_empty());
    }
}
