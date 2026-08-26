//! Minimal loopback HTTP listener for OAuth PKCE browser callbacks.
//!
//! Binds to 127.0.0.1:port, accepts exactly one connection, extracts the
//! request line's path+query (where the provider put `code`/`state`), replies
//! with a short confirmation page, then closes. Shared by every provider's
//! browser-based login flow (OpenRouter, Codex), the PKCE/token-exchange
//! logic itself lives in TS and reuses the existing `ai_http_request` proxy
//! or a direct `fetch` where CSP already allows it.

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::time::{timeout, Duration};

const RESPONSE_BODY: &str = "<!doctype html><html><body style=\"font-family:-apple-system,sans-serif;text-align:center;padding:4rem\"><h2>You're connected</h2><p>You can close this tab and go back to cli-ck.</p></body></html>";

#[tauri::command]
pub async fn oauth_loopback_listen(port: u16, timeout_secs: u64) -> Result<String, String> {
    let listener = TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|e| format!("could not listen on 127.0.0.1:{port}: {e}"))?;

    let (mut socket, _) = timeout(Duration::from_secs(timeout_secs), listener.accept())
        .await
        .map_err(|_| "timed out waiting for the browser to redirect back".to_string())?
        .map_err(|e| e.to_string())?;

    let mut buf = vec![0u8; 8192];
    let n = socket.read(&mut buf).await.map_err(|e| e.to_string())?;
    let request = String::from_utf8_lossy(&buf[..n]);
    let request_line = request.lines().next().unwrap_or("");
    // Expected shape: "GET /callback?code=...&state=... HTTP/1.1"
    let path_and_query = request_line
        .split_whitespace()
        .nth(1)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "malformed callback request".to_string())?
        .to_string();

    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        RESPONSE_BODY.len(),
        RESPONSE_BODY
    );
    let _ = socket.write_all(response.as_bytes()).await;
    let _ = socket.shutdown().await;

    Ok(path_and_query)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpStream;

    #[tokio::test]
    async fn captures_query_string_from_the_redirect() {
        let port = 51799; // arbitrary, distinct from the real callback ports
        let server = tokio::spawn(oauth_loopback_listen(port, 5));
        tokio::time::sleep(Duration::from_millis(50)).await;

        let mut client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        client
            .write_all(b"GET /callback?code=abc123&state=xyz HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .await
            .unwrap();

        let result = server.await.unwrap().unwrap();
        assert_eq!(result, "/callback?code=abc123&state=xyz");
    }

    #[tokio::test]
    async fn times_out_when_nobody_connects() {
        let result = oauth_loopback_listen(51798, 1).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("timed out"));
    }
}
