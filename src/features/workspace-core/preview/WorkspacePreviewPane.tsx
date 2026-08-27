import {
  Alert02Icon,
  Cursor02Icon,
  Globe02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  WorkspacePreviewAddressBar,
  type PreviewAddressBarHandle,
} from "./WorkspacePreviewAddressBar";

/** Must match the `MARKER` constant in
 *  `src-tauri/src/scripts/preview_bridge.js` — the script running inside
 *  the iframe and this component are two independent runtimes with no
 *  shared import, so the string has to be kept in sync by hand. */
const CLI_CK_BRIDGE_MARKER = "__cli_ck_bridge__";

const DEFAULT_RUN_TIMEOUT_MS = 15_000;

/** Facts about one clicked preview element, reported by the injected bridge
 *  script (see preview_bridge.js). Deliberately a fixed, budget-capped
 *  shape — not a raw DOM dump. */
export type InspectedElementFacts = {
  selector: string;
  tag: string;
  text: string;
  rect: { x: number; y: number; width: number; height: number };
  style: Record<string, string>;
  aria: Record<string, string>;
  sourcePointer: { fileName: string; lineNumber: number | null } | null;
};

/** Result of one `runInPreview` call — mirrors the bridge script's
 *  `run_result` message. `result` is whatever the script returned
 *  (JSON-safe, budget-capped by the bridge); `snapshot` is populated only
 *  when requested. */
export type PreviewRunResult = {
  ok: boolean;
  result?: unknown;
  error?: string;
  snapshot: string | null;
};

export type PreviewPaneHandle = {
  reload: () => void;
  focusAddressBar: () => void;
  getUrl: () => string;
  /** Arms click-to-inspect in the preview iframe and resolves with the
   *  clicked element's facts, or `null` if the user doesn't click anything
   *  within `timeoutMs` (default 60s) or there's no page loaded to inspect. */
  inspectElement: (timeoutMs?: number) => Promise<InspectedElementFacts | null>;
  /** Disarms click-to-inspect early (e.g. a Cancel button) and resolves any
   *  in-flight `inspectElement()` call with `null`. */
  cancelInspect: () => void;
  /** Runs `js` as an async function body inside the preview iframe, with
   *  `click(locator)`/`fill(locator, value)`/`wait(locator | ms)`/
   *  `read(locator)` bound as locals. Resolves `{ok:false, ...}` (never
   *  rejects) if there's no page loaded, the script throws, or it doesn't
   *  finish within `timeoutMs` (default 15s). */
  runInPreview: (
    js: string,
    opts?: { includeSnapshot?: boolean; timeoutMs?: number },
  ) => Promise<PreviewRunResult>;
};

type Props = {
  url: string;
  visible: boolean;
  onUrlChange: (url: string) => void;
};

// Tear the iframe down after this much invisibility — a background dev
// server page can hold hundreds of MB inside the WebView.
const SUSPEND_AFTER_MS = 30_000;
const DEFAULT_INSPECT_TIMEOUT_MS = 60_000;

export const WorkspacePreviewPane = forwardRef<PreviewPaneHandle, Props>(
  function WorkspacePreviewPane({ url, visible, onUrlChange }, ref) {
    // `nonce` is part of the iframe `key`. Bumping it remounts the iframe,
    // which is the only reliable cross-origin reload (calling
    // contentWindow.location.reload() throws on cross-origin frames).
    const [nonce, setNonce] = useState(0);
    const [loaded, setLoaded] = useState(visible);
    const [inspecting, setInspecting] = useState(false);
    const addressRef = useRef<PreviewAddressBarHandle>(null);
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const pendingInspectRef = useRef<{
      resolve: (facts: InspectedElementFacts | null) => void;
      timer: ReturnType<typeof setTimeout>;
    } | null>(null);
    const pendingRunsRef = useRef(
      new Map<
        string,
        { resolve: (result: PreviewRunResult) => void; timer: ReturnType<typeof setTimeout> }
      >(),
    );

    useEffect(() => {
      if (visible) {
        setLoaded(true);
        return;
      }
      const t = setTimeout(() => setLoaded(false), SUSPEND_AFTER_MS);
      return () => clearTimeout(t);
    }, [visible]);

    const settleInspect = useCallback((facts: InspectedElementFacts | null) => {
      const pending = pendingInspectRef.current;
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingInspectRef.current = null;
      setInspecting(false);
      pending.resolve(facts);
    }, []);

    const settleRun = useCallback((requestId: string, result: PreviewRunResult) => {
      const pending = pendingRunsRef.current.get(requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingRunsRef.current.delete(requestId);
      pending.resolve(result);
    }, []);

    // Fails every in-flight runInPreview call — used when the iframe itself
    // is going away (reload/nonce bump/URL change/suspend), since nothing
    // will ever answer them after that.
    const failAllRuns = useCallback((error: string) => {
      for (const [id, pending] of pendingRunsRef.current) {
        clearTimeout(pending.timer);
        pending.resolve({ ok: false, error, snapshot: null });
        pendingRunsRef.current.delete(id);
      }
    }, []);

    useEffect(() => {
      function onMessage(event: MessageEvent) {
        if (event.source !== iframeRef.current?.contentWindow) return;
        const data = event.data as {
          source?: string;
          type?: string;
          requestId?: string;
          [k: string]: unknown;
        } | null;
        if (!data || data.source !== CLI_CK_BRIDGE_MARKER) return;
        if (data.type === "result" && pendingInspectRef.current) {
          settleInspect({
            selector: String(data.selector ?? ""),
            tag: String(data.tag ?? ""),
            text: String(data.text ?? ""),
            rect: data.rect as InspectedElementFacts["rect"],
            style: data.style as Record<string, string>,
            aria: data.aria as Record<string, string>,
            sourcePointer:
              (data.source_pointer as InspectedElementFacts["sourcePointer"]) ??
              null,
          });
        } else if (data.type === "run_result" && typeof data.requestId === "string") {
          settleRun(data.requestId, {
            ok: Boolean(data.ok),
            result: data.result,
            error: typeof data.error === "string" ? data.error : undefined,
            snapshot: typeof data.snapshot === "string" ? data.snapshot : null,
          });
        }
      }
      window.addEventListener("message", onMessage);
      return () => window.removeEventListener("message", onMessage);
    }, [settleInspect, settleRun]);

    // Whenever the iframe element itself unmounts — a reload/nonce bump, a
    // URL change, or suspending into SuspendedState — its JS context (and
    // any armed listener inside it) is gone. Anything in flight can never
    // resolve after that, so fail it immediately instead of leaving it
    // hanging.
    const setIframeEl = useCallback(
      (el: HTMLIFrameElement | null) => {
        iframeRef.current = el;
        if (!el) {
          settleInspect(null);
          failAllRuns("preview reloaded before the script finished");
        }
      },
      [settleInspect, failAllRuns],
    );

    useImperativeHandle(
      ref,
      () => ({
        reload: () => {
          setLoaded(true);
          setNonce((n) => n + 1);
        },
        focusAddressBar: () => addressRef.current?.focus(),
        getUrl: () => url,
        inspectElement: (timeoutMs = DEFAULT_INSPECT_TIMEOUT_MS) =>
          new Promise<InspectedElementFacts | null>((resolve) => {
            const win = iframeRef.current?.contentWindow;
            if (!win) {
              resolve(null);
              return;
            }
            settleInspect(null); // cancel any prior in-flight request first
            const timer = setTimeout(() => settleInspect(null), timeoutMs);
            pendingInspectRef.current = { resolve, timer };
            setInspecting(true);
            win.postMessage(
              { source: CLI_CK_BRIDGE_MARKER, type: "start" },
              "*",
            );
          }),
        cancelInspect: () => {
          iframeRef.current?.contentWindow?.postMessage(
            { source: CLI_CK_BRIDGE_MARKER, type: "stop" },
            "*",
          );
          settleInspect(null);
        },
        runInPreview: (js, opts) =>
          new Promise<PreviewRunResult>((resolve) => {
            const win = iframeRef.current?.contentWindow;
            if (!win) {
              resolve({ ok: false, error: "no preview loaded", snapshot: null });
              return;
            }
            const requestId = crypto.randomUUID();
            const timeoutMs = opts?.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
            const timer = setTimeout(() => {
              settleRun(requestId, {
                ok: false,
                error: `script did not finish within ${timeoutMs}ms`,
                snapshot: null,
              });
            }, timeoutMs);
            pendingRunsRef.current.set(requestId, { resolve, timer });
            win.postMessage(
              {
                source: CLI_CK_BRIDGE_MARKER,
                type: "run",
                requestId,
                js,
                includeSnapshot: opts?.includeSnapshot ?? false,
              },
              "*",
            );
          }),
      }),
      [url, settleInspect, settleRun],
    );

    const showXfoHint = url ? !isLocalUrl(url) : false;

    return (
      <div
        className="flex h-full w-full flex-col overflow-hidden rounded-md border border-border/60 bg-background"
        style={{
          visibility: visible ? "visible" : "hidden",
          pointerEvents: visible ? "auto" : "none",
        }}
      >
        <WorkspacePreviewAddressBar
          ref={addressRef}
          url={url}
          onSubmit={onUrlChange}
          onReload={() => setNonce((n) => n + 1)}
        />
        {showXfoHint ? (
          <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-border/60 bg-amber-500/8 px-3 text-[11px] text-amber-600 dark:text-amber-400">
            <HugeiconsIcon
              icon={Alert02Icon}
              size={12}
              strokeWidth={1.75}
              className="shrink-0"
            />
            <span className="truncate">
              Many public sites refuse to embed (X-Frame-Options). If the page
              is blank, open it externally.
            </span>
          </div>
        ) : null}
        <div
          className={
            url
              ? "relative min-h-0 flex-1 bg-white"
              : "relative min-h-0 flex-1 bg-background"
          }
        >
          {inspecting ? (
            <div className="absolute inset-x-0 top-0 z-10 flex h-8 items-center justify-center gap-2 border-b border-border/60 bg-foreground/90 px-3 text-[11px] text-background">
              <HugeiconsIcon icon={Cursor02Icon} size={13} strokeWidth={1.75} />
              <span>Click an element in the preview to inspect it</span>
              <button
                type="button"
                onClick={() => {
                  iframeRef.current?.contentWindow?.postMessage(
                    { source: CLI_CK_BRIDGE_MARKER, type: "stop" },
                    "*",
                  );
                  settleInspect(null);
                }}
                className="ml-1 rounded border border-background/30 px-1.5 py-0.5 hover:bg-background/10"
              >
                Cancel
              </button>
            </div>
          ) : null}
          {url ? (
            loaded ? (
              <iframe
                ref={setIframeEl}
                key={`${url}#${nonce}`}
                src={url}
                title="Preview"
                className="h-full w-full border-0"
                // sandbox grants the bare minimum for a dev preview: scripts,
                // same-origin (cookies/storage for the previewed app), forms,
                // popups for "open in new tab". Critically OMITS
                // `allow-top-navigation*` — without it the iframe cannot
                // navigate the parent Tauri webview to an attacker origin,
                // which would otherwise expose `window.__TAURI__` IPC.
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
                referrerPolicy="no-referrer"
                allow="clipboard-read; clipboard-write; fullscreen"
              />
            ) : (
              <SuspendedState
                onReload={() => {
                  setLoaded(true);
                  setNonce((n) => n + 1);
                }}
              />
            )
          ) : (
            <EmptyState />
          )}
        </div>
      </div>
    );
  },
);

function SuspendedState({ onReload }: { onReload: () => void }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex size-10 items-center justify-center rounded-2xl border border-border/60 bg-card text-muted-foreground">
        <HugeiconsIcon icon={Globe02Icon} size={18} strokeWidth={1.5} />
      </div>
      <div className="space-y-1">
        <p className="text-[12.5px] font-medium text-foreground">
          Preview suspended
        </p>
        <p className="max-w-xs text-[11px] leading-relaxed text-muted-foreground">
          Released to free memory after sitting in the background.
        </p>
      </div>
      <button
        type="button"
        onClick={onReload}
        className="rounded-md border border-border/60 bg-card px-3 py-1 text-[11px] hover:bg-accent/50"
      >
        Reload
      </button>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="flex size-12 items-center justify-center rounded-2xl border border-border/60 bg-card text-muted-foreground">
        <HugeiconsIcon icon={Globe02Icon} size={20} strokeWidth={1.5} />
      </div>
      <div className="space-y-1.5">
        <p className="text-sm font-medium text-foreground">
          Nothing to preview yet
        </p>
        <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
          Type a URL above, or open the{" "}
          <span className="rounded bg-muted px-1 py-0.5 font-mono text-[10.5px]">
            Ports
          </span>{" "}
          dropdown to jump straight to your running dev server. Public sites
          often block embedding — open them in your browser via the link icon if
          you see a blank page.
        </p>
      </div>
    </div>
  );
}

function isLocalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const h = u.hostname;
    return (
      h === "localhost" ||
      h === "127.0.0.1" ||
      h === "0.0.0.0" ||
      h === "[::1]" ||
      h.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}
