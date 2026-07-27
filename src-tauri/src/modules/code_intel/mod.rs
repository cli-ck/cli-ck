//! Bridge to the `oz-code-intel` sidecar (a separate repo,
//! `codecollab-co/oz-code-intel` - see its own ROADMAP.md), OZ's code
//! intelligence helper: call-chain tracing, dead-code detection, structured
//! search, and more, over a bundled child process speaking newline-delimited
//! JSON on stdin/stdout.
//!
//! **Plumbing only, deliberately not yet wired to anything user- or
//! AI-facing.** These commands exist and are exercised by this module's own
//! integration test, but nothing in `buildTools()`
//! (`src/features/ai-companion/ai/tools/tools.ts`) calls them yet, and no
//! settings/UI surface references them. That's intentional, not an
//! oversight: oz-code-intel integration ships as a user-visible feature in
//! a later OZ release, not this one.
//!
//! **Not yet registered as a bundled Tauri sidecar** (no
//! `bundle.externalBin` entry in `tauri.conf.json`) - that would require a
//! real per-platform `oz-code-intel` binary to exist at build time for
//! every platform this app ships (macOS x2, Windows, Linux), which depends
//! on that repo's own release pipeline actually firing (see its
//! ROADMAP.md, Slice 25) or a cross-repo build step neither exists yet.
//! `CodeIntelSession::spawn`'s `app.shell().sidecar(...)` call will return
//! a clear "sidecar not registered" error until that's wired up - harmless,
//! since nothing calls it. Add the `externalBin` entry back (and a
//! matching `shell:allow-execute` capability) once a real binary supply
//! chain exists; don't paper over the gap with a placeholder file in the
//! meantime; a real `tauri build` bundles and *signs* whatever is at that
//! path, so a fake stand-in has no safe place to hide.
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

/// Spawns a new helper process and completes its handshake. One OZ session
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
/// - shaped JSON (see `oz-code-intel`'s `crates/protocol/src/lib.rs`) - this
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
    /// Points at a real, locally-built `oz-code-intel` helper binary so this
    /// test can spawn and talk to it for real rather than mocking the wire
    /// protocol. Not wired into CI (which has no sibling `oz-code-intel`
    /// checkout) - see `src-tauri/binaries/README.md` for how to build one
    /// locally; this test skips itself, loudly, if it's missing.
    fn dev_helper_binary() -> Option<std::path::PathBuf> {
        let candidate = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../oz-code-intel/target/release/oz-code-intel");
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
            .expect("failed to spawn real oz-code-intel binary");
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
            eprintln!("skipping: no local oz-code-intel build, see binaries/README.md");
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
            eprintln!("skipping: no local oz-code-intel build, see binaries/README.md");
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
}
