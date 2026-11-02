import { invoke } from "@tauri-apps/api/core";

let cached: string | undefined;
let cachedOpen: { path: string; line?: number } | undefined;

export async function initLaunchDir(): Promise<void> {
  const dir =
    (await invoke<string | null>("get_launch_dir").catch(() => null)) ??
    (await invoke<string>("workspace_current_dir").catch(() => null));
  cached = dir ? dir.replace(/\\/g, "/") : undefined;
  cachedOpen =
    (await invoke<{ path: string; line?: number } | null>("get_launch_open").catch(
      () => null,
    )) ?? undefined;
}

export function getLaunchDir(): string | undefined {
  return cached;
}

export function getLaunchOpen(): { path: string; line?: number } | undefined {
  if (!cachedOpen) return undefined;
  return {
    ...cachedOpen,
    path: cachedOpen.path.replace(/\\/g, "/"),
  };
}
