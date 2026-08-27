//! Real, separate Chromium instance automation (`browser_automate`) — the
//! CDP-driven counterpart to `browser_execute`'s in-iframe scripting
//! (`preview_bridge.js`), for testing against arbitrary sites the
//! dev-preview iframe can't reach (see ego-lite-browser-plan.md Slice 2).
//!
//! ## Attach-to-installed-Chrome, not bundled
//! `chromiumoxide`'s own executable detection (used when no
//! `chrome_executable(...)` is set) finds the system's installed
//! Chrome/Chromium — no binary shipped with cli-ck, no separate download to
//! keep patched.
//!
//! ## One global session, not one per workspace
//! A deliberate v1 simplification from the plan's "scoped per workspace" —
//! running several simultaneous automation sessions isn't a real need yet,
//! and this keeps session lifecycle trivial (no keying, no cleanup-on-tab-
//! close bookkeeping). Revisit only if that need actually shows up.
//!
//! ## Visible, never silent (Slice 2.5)
//! Launched non-headless (`with_head()`) — a real, separate OS window the
//! user can see, rather than a screencast mirrored into an in-app panel.
//! This is the simplest, most honest way to satisfy "never silent
//! automation": the user watches the actual browser being driven, in real
//! time, unmistakably not their own passive browsing — no custom UI
//! surface has to be trusted to represent that faithfully.
//!
//! ## Reuses preview_bridge.js verbatim, not a second locator engine
//! The plan's own text assumed no code could be shared between the iframe
//! surface (postMessage) and this one (CDP) — written before working out
//! the concrete mechanics. `Page::evaluate_on_new_document` injects a
//! script into every frame before that frame's own scripts run, the same
//! guarantee Tauri's `initialization_script_for_all_frames` gives the
//! iframe surface — so the *same* `preview_bridge.js` (already injected
//! there) works here unmodified via `window.__cliCkBridge`, resolved with
//! `Runtime.evaluate` instead of `postMessage`. No second implementation
//! of the locator mini-language.

use crate::PREVIEW_BRIDGE_JS;
use chromiumoxide::browser::{Browser, BrowserConfig};
use chromiumoxide::cdp::js_protocol::runtime::{CallArgument, CallFunctionOnParams};
use chromiumoxide::Page;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::sync::Mutex;

struct AutomationSession {
    browser: Browser,
    page: Page,
    // Kept alive for the session's lifetime — this is the task pumping the
    // CDP websocket; every other call on `browser`/`page` depends on it
    // still running. Never awaited or read, just held.
    _handler: tokio::task::JoinHandle<()>,
}

#[derive(Default)]
pub struct BrowserAutomationState(Mutex<Option<AutomationSession>>);

#[derive(Serialize)]
pub struct BrowserAutomationStatus {
    pub active: bool,
    pub url: Option<String>,
}

#[derive(Serialize)]
pub struct BrowserAutomationResult {
    pub ok: bool,
    pub result: Option<serde_json::Value>,
    pub error: Option<String>,
    pub snapshot: Option<String>,
    pub url: Option<String>,
}

// Matches the object literal the wrapper function in `browser_automation_run`
// returns — see that function for the actual script source.
#[derive(Deserialize)]
struct BridgeOutcome {
    ok: bool,
    #[serde(default)]
    result: Option<serde_json::Value>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    snapshot: Option<String>,
}

async fn ensure_session(state: &BrowserAutomationState) -> Result<(), String> {
    let mut guard = state.0.lock().await;
    if guard.is_some() {
        return Ok(());
    }
    let config = BrowserConfig::builder()
        .with_head()
        .build()
        .map_err(|e| format!("{e} — is Chrome installed?"))?;
    let (browser, mut handler) = Browser::launch(config)
        .await
        .map_err(|e| format!("could not launch a browser ({e}) — is Chrome installed?"))?;
    let _handler = tokio::task::spawn(async move { while handler.next().await.is_some() {} });
    let page = browser
        .new_page("about:blank")
        .await
        .map_err(|e| e.to_string())?;
    // Registered before any real navigation happens on this page, so it's
    // present on the first goto() onward — see module docs.
    page.evaluate_on_new_document(PREVIEW_BRIDGE_JS)
        .await
        .map_err(|e| e.to_string())?;
    *guard = Some(AutomationSession {
        browser,
        page,
        _handler,
    });
    Ok(())
}

#[tauri::command]
pub async fn browser_automation_status(
    state: State<'_, BrowserAutomationState>,
) -> Result<BrowserAutomationStatus, String> {
    let guard = state.0.lock().await;
    match guard.as_ref() {
        Some(session) => Ok(BrowserAutomationStatus {
            active: true,
            url: session.page.url().await.ok().flatten(),
        }),
        None => Ok(BrowserAutomationStatus {
            active: false,
            url: None,
        }),
    }
}

/// Closes the automated browser. Idempotent — a no-op if no session is
/// active.
#[tauri::command]
pub async fn browser_automation_stop(
    state: State<'_, BrowserAutomationState>,
) -> Result<(), String> {
    let mut guard = state.0.lock().await;
    if let Some(mut session) = guard.take() {
        let _ = session.browser.close().await;
    }
    Ok(())
}

/// Lazily launches the automated browser on first call. If `url` is given,
/// navigates there first (real CDP navigation — properly waits for load,
/// unlike an in-page `location.href` assignment, which would race the
/// script that runs right after it). Then runs `js` via
/// `window.__cliCkBridge.runScript` (see preview_bridge.js) in that page.
///
/// Never returns a bare `Err` for a script/navigation failure — those come
/// back as `{ok: false, error: ...}` so the caller (the `browser_automate`
/// tool) can hand the model an actionable result instead of a thrown error.
/// A real `Err` here means the browser itself is unreachable.
#[tauri::command]
pub async fn browser_automation_run(
    state: State<'_, BrowserAutomationState>,
    url: Option<String>,
    js: String,
    include_snapshot: bool,
) -> Result<BrowserAutomationResult, String> {
    ensure_session(&state).await?;
    let guard = state.0.lock().await;
    let session = guard
        .as_ref()
        .ok_or_else(|| "browser session not available".to_string())?;

    if let Some(url) = url {
        if let Err(e) = session.page.goto(url).await {
            return Ok(BrowserAutomationResult {
                ok: false,
                result: None,
                error: Some(format!("navigation failed: {e}")),
                snapshot: None,
                url: session.page.url().await.ok().flatten(),
            });
        }
    }

    // A fixed wrapper function; `js`/`include_snapshot` are passed as real
    // CDP call arguments (JSON-encoded, not string-interpolated into the
    // source) so nothing in an arbitrary script string can break out of it.
    let call = CallFunctionOnParams::builder()
        .function_declaration(
            "async function(js, includeSnapshot) {\
               var b = window.__cliCkBridge;\
               try {\
                 var result = await b.runScript(js);\
                 return { ok: true, result: result, snapshot: includeSnapshot ? b.buildSnapshot() : null };\
               } catch (e) {\
                 return { ok: false, error: String((e && e.message) || e), snapshot: includeSnapshot ? b.buildSnapshot() : null };\
               }\
             }",
        )
        .argument(CallArgument::builder().value(serde_json::json!(js)).build())
        .argument(CallArgument::builder().value(serde_json::json!(include_snapshot)).build())
        .await_promise(true)
        .build()
        .map_err(|e| e.to_string())?;

    let current_url = session.page.url().await.ok().flatten();

    let outcome = match session.page.evaluate_function(call).await {
        Ok(eval) => eval.into_value::<BridgeOutcome>(),
        Err(e) => {
            return Ok(BrowserAutomationResult {
                ok: false,
                result: None,
                error: Some(e.to_string()),
                snapshot: None,
                url: current_url,
            });
        }
    };

    match outcome {
        Ok(o) => Ok(BrowserAutomationResult {
            ok: o.ok,
            result: o.result,
            error: o.error,
            snapshot: o.snapshot,
            url: current_url,
        }),
        Err(e) => Ok(BrowserAutomationResult {
            ok: false,
            result: None,
            error: Some(e.to_string()),
            snapshot: None,
            url: current_url,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chrome_available() -> bool {
        chromiumoxide::detection::default_executable(Default::default()).is_ok()
    }

    // Exercises the real launch → inject → evaluate → close round trip end
    // to end when a Chrome/Chromium install is actually present; otherwise
    // (no browser on this machine's usual install paths) verifies that
    // absence degrades to the clean, actionable error message instead of a
    // panic — same "skip vs. verify the real thing" split as
    // claude_cli.rs's own external-binary test.
    #[tokio::test]
    async fn launches_injects_and_evaluates_or_fails_cleanly_without_chrome() {
        let state = BrowserAutomationState::default();

        if !chrome_available() {
            let err = ensure_session(&state).await.unwrap_err();
            assert!(
                err.to_lowercase().contains("chrome"),
                "expected a Chrome-mentioning error, got: {err}"
            );
            assert!(
                err.contains("is Chrome installed?"),
                "expected the actionable suffix, got: {err}"
            );
            return;
        }

        let config = BrowserConfig::builder().build().expect("headless config");
        let (browser, mut handler) = Browser::launch(config)
            .await
            .expect("a detected Chrome should launch headless");
        let _handler = tokio::task::spawn(async move { while handler.next().await.is_some() {} });
        let page = browser
            .new_page("about:blank")
            .await
            .expect("new_page should succeed");
        page.evaluate_on_new_document(PREVIEW_BRIDGE_JS)
            .await
            .expect("script injection should succeed");
        page.goto("data:text/html,<button id=go>Go</button>")
            .await
            .expect("navigation should succeed");

        let call = CallFunctionOnParams::builder()
            .function_declaration(
                "async function() { return window.__cliCkBridge.resolveLocator('css:#go').tagName; }",
            )
            .await_promise(true)
            .build()
            .unwrap();
        let tag: String = page
            .evaluate_function(call)
            .await
            .expect("evaluate_function should succeed")
            .into_value()
            .expect("result should deserialize");
        assert_eq!(tag, "BUTTON");
    }
}
