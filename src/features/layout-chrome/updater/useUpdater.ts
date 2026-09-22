import { getVersion } from "@tauri-apps/api/app";
import { arch, platform } from "@tauri-apps/plugin-os";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useState } from "react";
import { IS_LINUX } from "@/lib/platform";
import { isNewer, selectBetaRelease, type GithubRelease } from "./releases";

const LAST_CHECK_KEY = "cli-ck:updater:last-check";
const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const GITHUB_LATEST_RELEASE =
  "https://api.github.com/repos/cli-ck/cli-ck/releases/latest";
const GITHUB_RELEASES =
  "https://api.github.com/repos/cli-ck/cli-ck/releases?per_page=100";

export type UpdateChannel = "stable" | "beta";

export interface ManualUpdateInfo {
  version: string;
  currentVersion: string;
  body: string;
  releaseUrl: string;
  downloadUrl: string;
}

export type UpdaterStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "uptodate" }
  | { kind: "available"; update: Update }
  | { kind: "manual-available"; info: ManualUpdateInfo }
  | { kind: "downloading"; downloaded: number; contentLength: number | null }
  | { kind: "ready" }
  | { kind: "error"; message: string };

async function checkLinuxRelease(): Promise<ManualUpdateInfo | null> {
  const [current, res] = await Promise.all([
    getVersion(),
    fetch(GITHUB_LATEST_RELEASE, {
      headers: { Accept: "application/vnd.github+json" },
    }),
  ]);
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}`);
  }
  const data = (await res.json()) as {
    tag_name: string;
    body?: string;
    html_url: string;
  };
  const remote = data.tag_name.replace(/^v/, "");
  if (!isNewer(remote, current)) return null;
  return {
    version: remote,
    currentVersion: current,
    body: data.body ?? "",
    releaseUrl: data.html_url,
    downloadUrl: data.html_url,
  };
}

async function checkBetaRelease(): Promise<ManualUpdateInfo | null> {
  const [current, res] = await Promise.all([
    getVersion(),
    fetch(GITHUB_RELEASES, {
      headers: { Accept: "application/vnd.github+json" },
    }),
  ]);
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}`);
  }
  const release = selectBetaRelease(
    (await res.json()) as GithubRelease[],
    current,
    platform(),
    arch(),
  );
  return release ? { ...release, currentVersion: current } : null;
}

interface Options {
  /** Skip the time-based throttle on automatic startup checks. */
  manual?: boolean;
}

interface HookOptions {
  /** When false, the hook does not run an automatic check on mount. */
  autoCheck?: boolean;
  channel?: UpdateChannel;
}

export function useUpdater({
  autoCheck = true,
  channel = "stable",
}: HookOptions = {}) {
  const [status, setStatus] = useState<UpdaterStatus>({ kind: "idle" });

  const runCheck = useCallback(
    async ({ manual }: Options = {}) => {
      if (!manual) {
        const last = Number(localStorage.getItem(LAST_CHECK_KEY) ?? 0);
        if (Date.now() - last < CHECK_INTERVAL_MS) return;
      }
      setStatus({ kind: "checking" });
      try {
        if (channel === "beta") {
          const info = await checkBetaRelease();
          if (info) {
            setStatus({ kind: "manual-available", info });
          } else {
            localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
            setStatus({ kind: "uptodate" });
          }
          return;
        }
        if (IS_LINUX) {
          const info = await checkLinuxRelease();
          if (info) {
            setStatus({ kind: "manual-available", info });
          } else {
            localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
            setStatus({ kind: "uptodate" });
          }
          return;
        }
        const update = await check();
        if (update) {
          setStatus({ kind: "available", update });
        } else {
          localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
          setStatus({ kind: "uptodate" });
        }
      } catch (err) {
        setStatus({ kind: "error", message: String(err) });
      }
    },
    [channel],
  );

  const install = useCallback(async () => {
    if (status.kind !== "available") return;
    const { update } = status;
    let total: number | null = null;
    let downloaded = 0;
    setStatus({ kind: "downloading", downloaded: 0, contentLength: null });
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? null;
          setStatus({
            kind: "downloading",
            downloaded: 0,
            contentLength: total,
          });
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setStatus({ kind: "downloading", downloaded, contentLength: total });
        } else if (event.event === "Finished") {
          setStatus({ kind: "ready" });
        }
      });
      await relaunch();
    } catch (err) {
      setStatus({ kind: "error", message: String(err) });
    }
  }, [status]);

  const dismiss = useCallback(() => {
    setStatus({ kind: "idle" });
  }, []);

  useEffect(() => {
    if (!autoCheck) return;
    void runCheck();
  }, [autoCheck, runCheck]);

  return { status, check: runCheck, install, dismiss };
}
