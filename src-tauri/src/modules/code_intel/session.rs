use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::oneshot;

/// The `binaries/<name>` string tauri.conf.json's `bundle.externalBin` and
/// the `code-intel` capability both key on - all three must agree.
const SIDECAR_NAME: &str = "binaries/cli-ck-code-intel";

type PendingMap = Arc<Mutex<HashMap<u64, oneshot::Sender<serde_json::Value>>>>;

/// One running `cli-ck-code-intel` helper process plus the request/response
/// bookkeeping needed to talk to it.
///
/// Deliberately has no compile-time dependency on the `cli-ck-code-intel` repo's
/// `protocol` crate - the two repos version independently (see that repo's
/// ROADMAP.md), so this only ever speaks its wire format (newline-delimited
/// JSON, `{"id": u64, "payload": {"type": "...", ...}}`) via `serde_json::Value`.
pub struct CodeIntelSession {
    child: Mutex<Option<CommandChild>>,
    next_request_id: AtomicU64,
    pending: PendingMap,
}

impl CodeIntelSession {
    /// Spawns the bundled sidecar and performs the protocol handshake
    /// (`Hello`/`Hello`) before returning - a session is never handed back
    /// half-alive.
    pub async fn spawn(app: &tauri::AppHandle) -> Result<Arc<Self>, String> {
        let sidecar = app
            .shell()
            .sidecar(SIDECAR_NAME)
            .map_err(|e| format!("code-intel: sidecar not registered: {e}"))?;
        let (mut rx, child) = sidecar
            .spawn()
            .map_err(|e| format!("code-intel: failed to spawn helper: {e}"))?;

        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let reader_pending = pending.clone();

        tauri::async_runtime::spawn(async move {
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(line_bytes) => {
                        let line = String::from_utf8_lossy(&line_bytes);
                        let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim_end())
                        else {
                            log::warn!("code-intel: unparseable line from helper: {line}");
                            continue;
                        };
                        let Some(id) = value.get("id").and_then(|v| v.as_u64()) else {
                            continue;
                        };
                        if let Some(tx) = reader_pending.lock().unwrap().remove(&id) {
                            let _ = tx.send(value);
                        }
                    }
                    CommandEvent::Stderr(bytes) => {
                        log::warn!(
                            "code-intel: helper stderr: {}",
                            String::from_utf8_lossy(&bytes)
                        );
                    }
                    CommandEvent::Error(err) => {
                        log::error!("code-intel: sidecar error: {err}");
                        break;
                    }
                    CommandEvent::Terminated(payload) => {
                        log::info!("code-intel: helper exited: {:?}", payload.code);
                        break;
                    }
                    _ => {}
                }
            }
            // The helper is gone: fail every still-pending request rather
            // than leaving its caller waiting on a oneshot that will now
            // never fire.
            for (_, tx) in reader_pending.lock().unwrap().drain() {
                let _ = tx.send(serde_json::json!({
                    "payload": { "type": "error", "message": "code-intel: helper process exited" }
                }));
            }
        });

        let session = Arc::new(Self {
            child: Mutex::new(Some(child)),
            next_request_id: AtomicU64::new(1),
            pending,
        });

        let hello = session
            .request(serde_json::json!({
                "type": "hello",
                "client_version": env!("CARGO_PKG_VERSION"),
            }))
            .await?;
        if hello.get("type").and_then(|v| v.as_str()) != Some("hello") {
            session.kill();
            return Err(format!("code-intel: unexpected handshake reply: {hello}"));
        }

        Ok(session)
    }

    /// Sends one `RequestPayload`-shaped JSON value, returns the matching
    /// `ResponsePayload`-shaped value. Requests may be issued concurrently -
    /// the helper processes its stdin strictly in order and this matches
    /// each reply back to its caller by `id`, not by arrival order.
    pub async fn request(&self, payload: serde_json::Value) -> Result<serde_json::Value, String> {
        let id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);

        let mut line = serde_json::to_string(&serde_json::json!({ "id": id, "payload": payload }))
            .map_err(|e| format!("code-intel: failed to encode request: {e}"))?;
        line.push('\n');

        {
            let mut guard = self.child.lock().unwrap();
            let child = guard
                .as_mut()
                .ok_or_else(|| "code-intel: helper is not running".to_string())?;
            child
                .write(line.as_bytes())
                .map_err(|e| format!("code-intel: write failed: {e}"))?;
        }

        let response = rx.await.map_err(|_| {
            self.pending.lock().unwrap().remove(&id);
            "code-intel: helper closed before replying".to_string()
        })?;

        response
            .get("payload")
            .cloned()
            .ok_or_else(|| "code-intel: response missing a payload field".to_string())
    }

    pub fn kill(&self) {
        if let Some(child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
        }
    }
}

impl Drop for CodeIntelSession {
    fn drop(&mut self) {
        self.kill();
    }
}
