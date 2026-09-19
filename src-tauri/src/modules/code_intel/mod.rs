//! Bridge to the `cli-ck-code-intel` sidecar (a separate repo,
//! `cli-ck/cli-ck-code-intel` - see its own ROADMAP.md), cli-ck's code
//! intelligence helper: call-chain tracing, dead-code detection, structured
//! search, and more, over a bundled child process speaking newline-delimited
//! JSON on stdin/stdout.
//!
//! The three free, read-only Code Intel tools are registered in the AI Sidebar
//! via `buildTools()` (`src/features/ai-companion/ai/tools/tools.ts`). Tauri
//! bundles the helper from `src-tauri/binaries` and signs it with the app.
//! Release workflows stage only the version-pinned, SHA-256-verified asset
//! from the private `cli-ck-code-intel` release before invoking Tauri.
mod session;

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, RwLock};

use session::CodeIntelSession;

#[derive(Default)]
pub struct CodeIntelState {
    sessions: RwLock<std::collections::HashMap<u32, Arc<CodeIntelSession>>>,
    next_id: AtomicU32,
}

impl CodeIntelState {
    pub fn kill_all(&self) {
        for (_, session) in self.sessions.write().unwrap().drain() {
            session.kill();
        }
    }
}

/// Spawns a new helper process and completes its handshake. One cli-ck session
/// can hold several of these (e.g. one per open project), same as `lsp_spawn`.
#[tauri::command]
pub async fn code_intel_spawn(
    app: tauri::AppHandle,
    state: tauri::State<'_, CodeIntelState>,
) -> Result<u32, String> {
    let session = CodeIntelSession::spawn(&app).await?;
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    state.sessions.write().unwrap().insert(id, session);
    log::info!("code-intel: helper spawned, session id={id}");
    Ok(id)
}

/// Sends one request to a running helper and returns its response.
/// `payload` and the return value are both `RequestPayload`/`ResponsePayload`
/// - shaped JSON (see `cli-ck-code-intel`'s `crates/protocol/src/lib.rs`) - this
/// module has no compiled knowledge of those shapes, by design (see the
/// module doc comment).
#[tauri::command]
pub async fn code_intel_request(
    state: tauri::State<'_, CodeIntelState>,
    id: u32,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let session = state
        .sessions
        .read()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("code_intel_request: unknown session id={id}"))?;
    session.request(payload).await
}

#[tauri::command]
pub fn code_intel_kill(state: tauri::State<'_, CodeIntelState>, id: u32) {
    if let Some(session) = state.sessions.write().unwrap().remove(&id) {
        session.kill();
        log::info!("code-intel: helper killed, session id={id}");
    }
}

#[cfg(test)]
mod tests {
    /// Points at a real, locally-built `cli-ck-code-intel` helper binary so this
    /// test can spawn and talk to it for real rather than mocking the wire
    /// protocol. Not wired into CI (which has no sibling `cli-ck-code-intel`
    /// checkout) - see `src-tauri/binaries/README.md` for how to build one
    /// locally; this test skips itself, loudly, if it's missing.
    fn dev_helper_binary() -> Option<std::path::PathBuf> {
        let candidate = std::env::var_os("CLI_CK_CODE_INTEL_BINARY")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../cli-ck-code-intel/target/release/cli-ck-code-intel")
            });
        candidate.exists().then_some(candidate)
    }

    /// A minimal stand-in for `app.shell().sidecar(...).spawn()` that talks
    /// to a real binary via plain `std::process::Command`, so the wire
    /// protocol itself (handshake framing, id-matched request/response) is
    /// exercised without needing a running Tauri `AppHandle` in a unit test.
    /// `CodeIntelSession::spawn`'s Tauri-specific half (sidecar resolution)
    /// is exercised instead by manual `tauri dev` verification - see the PR
    /// description.
    fn round_trip(binary: &std::path::Path, request_line: &str) -> serde_json::Value {
        use std::io::{BufRead, Write};
        use std::process::{Command, Stdio};

        let mut child = Command::new(binary)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("failed to spawn real cli-ck-code-intel binary");
        child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(format!("{request_line}\n").as_bytes())
            .unwrap();
        let mut line = String::new();
        std::io::BufReader::new(child.stdout.as_mut().unwrap())
            .read_line(&mut line)
            .unwrap();
        let _ = child.kill();
        let _ = child.wait();
        serde_json::from_str(line.trim_end()).expect("helper returned invalid JSON")
    }

    #[test]
    fn real_helper_completes_the_hello_handshake() {
        let Some(binary) = dev_helper_binary() else {
            eprintln!("skipping: no local cli-ck-code-intel build, see binaries/README.md");
            return;
        };
        let response = round_trip(
            &binary,
            r#"{"id":1,"payload":{"type":"hello","client_version":"test"}}"#,
        );
        assert_eq!(response["id"], 1);
        assert_eq!(response["payload"]["type"], "hello");
        assert!(response["payload"]["helper_version"].is_string());
    }

    #[test]
    fn real_helper_answers_a_free_tier_grep_search() {
        let Some(binary) = dev_helper_binary() else {
            eprintln!("skipping: no local cli-ck-code-intel build, see binaries/README.md");
            return;
        };
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("main.rs"), "fn hello_world() {}\n").unwrap();

        let request = serde_json::json!({
            "id": 1,
            "payload": {
                "type": "grep_search",
                "repo_path": tmp.path().to_string_lossy(),
                "pattern": "hello_world",
            }
        });
        let response = round_trip(&binary, &request.to_string());
        assert_eq!(response["payload"]["type"], "grep_search");
        let matches = response["payload"]["matches"].as_array().unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0]["file"], "main.rs");
    }

    #[test]
    fn real_helper_answers_the_three_ai_sidebar_requests() {
        let Some(binary) = dev_helper_binary() else {
            eprintln!("skipping: no local cli-ck-code-intel build, see binaries/README.md");
            return;
        };
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("workspace.ts"),
            "function saveWorkspace() {}\nfunction caller() { saveWorkspace(); }\n",
        )
        .unwrap();
        let repo = tmp.path().to_str().unwrap();
        assert!(
            std::process::Command::new("git")
                .args(["-C", repo, "init", "-b", "main"])
                .status()
                .unwrap()
                .success()
        );
        for args in [
            &["config", "user.email", "tests@cli-ck.dev"][..],
            &["config", "user.name", "cli-ck tests"][..],
            &["add", "workspace.ts"][..],
            &["commit", "-m", "initial workspace"][..],
        ] {
            assert!(
                std::process::Command::new("git")
                    .args(["-C", repo])
                    .args(args)
                    .status()
                    .unwrap()
                    .success()
            );
        }
        std::fs::write(
            tmp.path().join("workspace.ts"),
            "function saveWorkspace() { return true; }\nfunction caller() { saveWorkspace(); }\n",
        )
        .unwrap();

        let trace = serde_json::json!({
            "id": 1,
            "payload": {
                "type": "trace_call_chain",
                "repo_path": tmp.path().to_string_lossy(),
                "function_name": "saveWorkspace",
                "direction": "both",
                "depth": 2,
                "include_tests": false,
                "mode": "calls",
            }
        });
        let response = round_trip(&binary, &trace.to_string());
        assert_eq!(response["payload"]["type"], "trace_call_chain");
        assert_eq!(response["payload"]["callers_total"], 1);

        let snippet = serde_json::json!({
            "id": 1,
            "payload": {
                "type": "get_code_snippet",
                "repo_path": tmp.path().to_string_lossy(),
                "qualified_name": "saveWorkspace",
                "include_neighbors": false,
            }
        });
        let response = round_trip(&binary, &snippet.to_string());
        assert_eq!(response["payload"]["type"], "get_code_snippet");
        assert!(
            response["payload"]["source"]
                .as_str()
                .unwrap()
                .contains("saveWorkspace")
        );

        let impact = serde_json::json!({
            "id": 1,
            "payload": {
                "type": "diff_impact",
                "repo_path": tmp.path().to_string_lossy(),
                "base": "main",
                "direction": "inbound",
                "depth": 2,
            }
        });
        let response = round_trip(&binary, &impact.to_string());
        assert_eq!(response["payload"]["type"], "diff_impact");
        assert_eq!(response["payload"]["changed_files"][0], "workspace.ts");
    }
}
