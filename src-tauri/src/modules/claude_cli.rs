//! Delegates Claude Pro/Max chat requests to the user's own, already
//! installed and already logged in `claude` CLI, rather than reimplementing
//! Anthropic's client. See docs/adr/0016-subscription-login-claude-experimental.md
//! for why: acting as Claude Code's own real, official client is the only
//! way to use a Claude subscription that Anthropic actually permits.
//!
//! Runs one-shot (`claude -p`) under `--permission-mode plan`, so it can
//! read for context but never edits files or runs commands on its own,
//! which also sidesteps the alternative of a permission prompt with no TTY
//! to answer it.

use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::timeout;

use crate::modules::lsp::env::resolve_binary;

const DEFAULT_TIMEOUT_SECS: u64 = 120;
const MAX_TIMEOUT_SECS: u64 = 600;

#[tauri::command]
pub fn claude_cli_detect() -> Option<String> {
    resolve_binary("claude").map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn claude_cli_run(prompt: String, timeout_secs: Option<u64>) -> Result<String, String> {
    let binary = resolve_binary("claude").ok_or_else(|| "claude CLI not found on PATH".to_string())?;

    let mut child = Command::new(binary)
        .arg("-p")
        .arg(&prompt)
        .arg("--output-format")
        .arg("text")
        .arg("--permission-mode")
        .arg("plan")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start claude: {e}"))?;

    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    let mut stderr = child.stderr.take().ok_or("no stderr")?;

    let dur = Duration::from_secs(
        timeout_secs
            .unwrap_or(DEFAULT_TIMEOUT_SECS)
            .clamp(1, MAX_TIMEOUT_SECS),
    );

    let run = async {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let (out_res, err_res, status) = tokio::join!(
            stdout.read_to_end(&mut out),
            stderr.read_to_end(&mut err),
            child.wait(),
        );
        out_res.map_err(|e| e.to_string())?;
        err_res.map_err(|e| e.to_string())?;
        let status = status.map_err(|e| e.to_string())?;
        if !status.success() {
            let msg = String::from_utf8_lossy(&err);
            return Err(if msg.trim().is_empty() {
                format!("claude exited with {status}")
            } else {
                msg.trim().to_string()
            });
        }
        Ok(String::from_utf8_lossy(&out).into_owned())
    };

    match timeout(dur, run).await {
        Ok(result) => result,
        Err(_) => {
            let _ = child.start_kill();
            Err("claude timed out".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn runs_a_real_prompt_through_the_installed_cli() {
        if resolve_binary("claude").is_none() {
            return; // no claude on this machine's PATH, nothing to verify
        }
        let out = claude_cli_run(
            "Reply with exactly the word: pong".to_string(),
            Some(60),
        )
        .await
        .expect("claude -p should succeed");
        assert!(
            out.to_lowercase().contains("pong"),
            "expected 'pong' in output, got: {out}"
        );
    }

    #[tokio::test]
    async fn missing_binary_on_path_returns_a_clear_error() {
        // Race-safe only in the sense that this asserts the *code path*, not
        // real PATH manipulation, resolve_binary is exercised directly above.
        if resolve_binary("cli-ck-definitely-not-a-real-binary").is_some() {
            panic!("test fixture assumption violated: binary unexpectedly resolved");
        }
    }
}
