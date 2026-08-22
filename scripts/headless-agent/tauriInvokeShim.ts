/**
 * Headless replacement for `@tauri-apps/api/core`'s `invoke`, used only by
 * scripts/headless-agent/run.mjs (aliased in there via Vite SSR, never
 * bundled into the shipping app). Re-implements the local-workspace subset
 * of the Rust `#[tauri::command]` handlers under src-tauri/src/modules/{fs,
 * shell}/*.rs directly against Node's fs/child_process, so cli-ck's real
 * agent loop (aiAgent.ts -> tools/*.ts -> lib/native.ts) can run outside the
 * Tauri webview. WSL-only commands (wsl_*) are intentionally unimplemented —
 * headless mode is local-workspace only.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

const MAX_READ_BYTES = 10 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8 * 1024;
const FILE_SIZE_CAP = 5 * 1024 * 1024;
const DEFAULT_GREP_RESULTS = 200;
const HARD_MAX_RESULTS = 2000;
const DEFAULT_TIMEOUT_SECS = 30;
const MAX_TIMEOUT_SECS = 300;
const MAX_OUTPUT_BYTES = 256 * 1024;
const PRUNE_DIRS = new Set([
  "node_modules",
  ".git",
  "target",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  ".venv",
  "__pycache__",
]);

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Gitignore-aware relative file listing: `git ls-files` when the root is a
 * repo (matches the Rust `ignore` crate closely enough for benchmark repos),
 * else a manual walk pruning the same heavy dirs the Rust search module
 * hard-codes. */
async function listCandidateFiles(root: string): Promise<string[]> {
  if (await exists(path.join(root, ".git"))) {
    const out = await runCapture("git", ["ls-files", "-co", "--exclude-standard"], root);
    if (out.exitCode === 0) {
      return out.stdout.split("\n").filter(Boolean);
    }
  }
  const results: string[] = [];
  async function walk(dir: string, rel: string) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) {
        if (PRUNE_DIRS.has(e.name)) continue;
        await walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
      } else if (e.isFile()) {
        results.push(rel ? `${rel}/${e.name}` : e.name);
      }
    }
  }
  await walk(root, "");
  return results;
}

function runCapture(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.on("error", () => resolve({ stdout: "", exitCode: -1 }));
    child.on("close", (code) => resolve({ stdout, exitCode: code }));
  });
}

/** Minimal globset-style matcher: supports `**`, `*`, `?`. Not a full port
 * of the Rust `globset` crate, but covers the patterns the agent actually
 * emits (`**\/*.ts`, `src/**\/test_*.py`). */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

// ── fs ──────────────────────────────────────────────────────────────────

async function fsReadFile(pathArg: string) {
  const stat = await fsp.stat(pathArg);
  if (stat.size > MAX_READ_BYTES) {
    return { kind: "toolarge", size: stat.size, limit: MAX_READ_BYTES };
  }
  const buf = await fsp.readFile(pathArg);
  const sniffLen = Math.min(buf.length, BINARY_SNIFF_BYTES);
  if (buf.subarray(0, sniffLen).includes(0)) {
    return { kind: "binary", size: stat.size };
  }
  try {
    // Round-trip through the fatal decoder — mirrors Rust's String::from_utf8.
    const content = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return { kind: "text", content, size: stat.size };
  } catch {
    return { kind: "binary", size: stat.size };
  }
}

async function fsWriteFile(pathArg: string, content: string) {
  const dir = path.dirname(pathArg);
  const tmp = path.join(dir, `.${path.basename(pathArg)}.${randomUUID()}.tmp`);
  await fsp.writeFile(tmp, content, "utf8");
  await fsp.rename(tmp, pathArg);
}

async function fsCreateFile(pathArg: string) {
  if (await exists(pathArg)) throw new Error(`already exists: ${pathArg}`);
  await fsp.writeFile(pathArg, "", { flag: "wx" });
}

async function fsCreateDir(pathArg: string) {
  if (await exists(pathArg)) throw new Error(`already exists: ${pathArg}`);
  await fsp.mkdir(pathArg, { recursive: true });
}

async function fsReadDir(pathArg: string) {
  const entries = await fsp.readdir(pathArg, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(pathArg, e.name);
    const stat = await fsp.lstat(full);
    const kind = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "dir" : "file";
    out.push({
      name: e.name,
      kind,
      size: stat.size,
      mtime: Math.floor(stat.mtimeMs),
      gitignored: false,
    });
  }
  return out;
}

async function fsGrep(args: {
  pattern: string;
  root: string;
  glob?: string[] | null;
  caseInsensitive?: boolean | null;
  maxResults?: number | null;
}) {
  if (!args.pattern) throw new Error("empty pattern");
  const cap = Math.min(Math.max(args.maxResults ?? DEFAULT_GREP_RESULTS, 1), HARD_MAX_RESULTS);
  const flags = args.caseInsensitive ? "i" : "";
  const re = new RegExp(args.pattern, flags);
  const globRes = (args.glob ?? []).map(globToRegExp);
  const files = await listCandidateFiles(args.root);
  const hits: { path: string; rel: string; line: number; text: string }[] = [];
  let filesScanned = 0;
  let truncated = false;
  for (const rel of files) {
    if (globRes.length > 0 && !globRes.some((g) => g.test(rel))) continue;
    const abs = path.join(args.root, rel);
    let stat;
    try {
      stat = await fsp.stat(abs);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > FILE_SIZE_CAP) continue;
    filesScanned++;
    let text: string;
    try {
      text = await fsp.readFile(abs, "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        if (hits.length >= cap) {
          truncated = true;
          break;
        }
        hits.push({ path: abs, rel, line: i + 1, text: lines[i] });
      }
    }
    if (truncated) break;
  }
  return { hits, truncated, files_scanned: filesScanned };
}

async function fsGlob(args: { pattern: string; root: string; maxResults?: number | null }) {
  if (!args.pattern) throw new Error("empty pattern");
  const cap = Math.min(Math.max(args.maxResults ?? 500, 1), HARD_MAX_RESULTS);
  const re = globToRegExp(args.pattern);
  const files = await listCandidateFiles(args.root);
  const matched = files.filter((f) => re.test(f));
  const truncated = matched.length > cap;
  const hits = matched.slice(0, cap).map((rel) => ({ path: path.join(args.root, rel), rel }));
  return { hits, truncated };
}

// ── shell ───────────────────────────────────────────────────────────────

function runOneshot(
  command: string,
  cwd: string | null,
  timeoutSecs?: number | null,
): Promise<{
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  truncated: boolean;
}> {
  return new Promise((resolve, reject) => {
    const trimmed = command.trim();
    if (!trimmed) return reject(new Error("empty command"));
    const dur = Math.min(Math.max(timeoutSecs ?? DEFAULT_TIMEOUT_SECS, 1), MAX_TIMEOUT_SECS) * 1000;
    const child = spawn(trimmed, {
      cwd: cwd ?? undefined,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    const cap = (buf: Buffer, chunk: Buffer) => {
      if (buf.length >= MAX_OUTPUT_BYTES) {
        truncated = true;
        return buf;
      }
      const next = Buffer.concat([buf, chunk]);
      if (next.length > MAX_OUTPUT_BYTES) {
        truncated = true;
        return next.subarray(0, MAX_OUTPUT_BYTES);
      }
      return next;
    };
    child.stdout.on("data", (d) => (stdout = cap(stdout, d)));
    child.stderr.on("data", (d) => (stderr = cap(stderr, d)));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, dur);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        exit_code: timedOut ? null : code,
        timed_out: timedOut,
        truncated,
      });
    });
  });
}

// ponytail: sessions track a logical cwd and re-run each command via a
// fresh `sh -c`, recovering post-command cwd from a trailing marker —
// not a real persistent shell (env vars/aliases don't survive between
// calls). Upgrade path: a long-lived pty-backed session if benchmark
// tasks ever need stateful shell setup beyond `cd`.
const sessions = new Map<number, { cwd: string }>();
let nextSessionId = 1;
const bgProcs = new Map<
  number,
  { command: string; cwd: string | null; startedAt: number; buf: string; exited: boolean; exitCode: number | null }
>();
let nextBgId = 1;

async function shellSessionRun(
  id: number,
  command: string,
  cwdOverride: string | null,
  timeoutSecs?: number | null,
) {
  const session = sessions.get(id);
  if (!session) throw new Error(`unknown shell session ${id}`);
  const cwd = cwdOverride ?? session.cwd;
  const marker = `__CWD_${randomUUID().replace(/-/g, "")}__`;
  const wrapped = `${command}\nprintf '\\n${marker}:%s\\n' "$PWD"`;
  const r = await runOneshot(wrapped, cwd, timeoutSecs);
  const markerIdx = r.stdout.lastIndexOf(`${marker}:`);
  let cwdAfter = cwd;
  let stdout = r.stdout;
  if (markerIdx !== -1) {
    cwdAfter = r.stdout.slice(markerIdx + marker.length + 1).trim();
    stdout = r.stdout.slice(0, markerIdx).replace(/\n$/, "");
  }
  session.cwd = cwdAfter;
  return { ...r, stdout, cwd_after: cwdAfter };
}

// ── invoke dispatch ─────────────────────────────────────────────────────

export async function invoke<T>(cmd: string, rawArgs?: Record<string, unknown>): Promise<T> {
  const args = rawArgs ?? {};
  switch (cmd) {
    case "workspace_current_dir":
      return process.cwd() as unknown as T;
    case "workspace_authorize":
      return (args.path as string) as unknown as T;

    case "fs_read_file":
      return (await fsReadFile(args.path as string)) as unknown as T;
    case "fs_write_file":
      await fsWriteFile(args.path as string, args.content as string);
      return undefined as unknown as T;
    case "fs_canonicalize":
      return (await fsp.realpath(args.path as string)) as unknown as T;
    case "fs_create_file":
      await fsCreateFile(args.path as string);
      return undefined as unknown as T;
    case "fs_create_dir":
      await fsCreateDir(args.path as string);
      return undefined as unknown as T;
    case "fs_read_dir":
      return (await fsReadDir(args.path as string)) as unknown as T;
    case "fs_grep":
      return (await fsGrep(
        args as { pattern: string; root: string; glob?: string[] | null; caseInsensitive?: boolean | null; maxResults?: number | null },
      )) as unknown as T;
    case "fs_glob":
      return (await fsGlob(args as { pattern: string; root: string; maxResults?: number | null })) as unknown as T;

    case "shell_run_command":
      return (await runOneshot(
        args.command as string,
        (args.cwd as string | null) ?? null,
        args.timeoutSecs as number | null | undefined,
      )) as unknown as T;

    case "shell_session_open": {
      const id = nextSessionId++;
      sessions.set(id, { cwd: (args.cwd as string | null) ?? process.cwd() });
      return id as unknown as T;
    }
    case "shell_session_run":
      return (await shellSessionRun(
        args.id as number,
        args.command as string,
        (args.cwd as string | null) ?? null,
        args.timeoutSecs as number | null | undefined,
      )) as unknown as T;
    case "shell_session_close":
      sessions.delete(args.id as number);
      return undefined as unknown as T;

    case "shell_bg_spawn": {
      const id = nextBgId++;
      const cwd = (args.cwd as string | null) ?? null;
      const command = args.command as string;
      const info = { command, cwd, startedAt: Date.now(), buf: "", exited: false, exitCode: null as number | null };
      bgProcs.set(id, info);
      const child = spawn(command, { cwd: cwd ?? undefined, shell: true, stdio: ["ignore", "pipe", "pipe"] });
      const onData = (d: Buffer) => {
        info.buf += d.toString("utf8");
        if (info.buf.length > 4 * 1024 * 1024) info.buf = info.buf.slice(-4 * 1024 * 1024);
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("close", (code) => {
        info.exited = true;
        info.exitCode = code;
      });
      return id as unknown as T;
    }
    case "shell_bg_logs": {
      const info = bgProcs.get(args.handle as number);
      if (!info) throw new Error(`unknown background process ${args.handle}`);
      const since = (args.sinceOffset as number | null) ?? 0;
      const bytes = info.buf.slice(since);
      return {
        bytes,
        next_offset: info.buf.length,
        dropped: 0,
        exited: info.exited,
        exit_code: info.exitCode,
      } as unknown as T;
    }
    case "shell_bg_kill": {
      bgProcs.delete(args.handle as number);
      return undefined as unknown as T;
    }
    case "shell_bg_list": {
      const out = Array.from(bgProcs.entries()).map(([handle, p]) => ({
        handle,
        command: p.command,
        cwd: p.cwd,
        started_at_ms: p.startedAt,
        exited: p.exited,
        exit_code: p.exitCode,
      }));
      return out as unknown as T;
    }

    default:
      throw new Error(
        `headless tauriInvokeShim: unimplemented command "${cmd}" (WSL/git-panel/lsp commands are out of scope for headless benchmarks)`,
      );
  }
}
