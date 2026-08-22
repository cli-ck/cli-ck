#!/usr/bin/env node
/**
 * Runs the task suite in bench-tasks.mjs against cli-ck's headless agent
 * (run.mjs) and one or more competitor CLIs — Warp's `oz agent run`, OpenAI's
 * `codex exec`, Block's `goose run`, `opencode run`, or `aider` — on freshly
 * seeded scratch repos, and reports wall-clock time + tokens + pass/fail per
 * task per tool.
 *
 * Requires:
 *   ANTHROPIC_API_KEY or OPENAI_API_KEY  — for cli-ck's agent (per --provider)
 *   WARP_API_KEY                         — for oz
 *   OPENAI_API_KEY                       — for codex/goose/opencode/aider
 *                                           (codex logs into an isolated
 *                                           CODEX_HOME so it never touches a
 *                                           real ChatGPT-account login)
 *
 * Usage:
 *   node scripts/headless-agent/bench-suite.mjs [--tool cli-ck|both|oz|codex|goose|opencode|aider] [--competitor codex,goose,opencode,aider] [--model gpt-4o-mini] [--tasks id1,id2]
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { TASKS } from "./bench-tasks.mjs";

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

// ponytail: hardcoded to binaries' actual locations on this machine.
// Upgrade to `which <bin>` first if this ever runs on a different box.
const OZ_BIN = "/Applications/Warp.app/Contents/Resources/bin/oz";
const AIDER_BIN = path.join(os.homedir(), ".local/bin/aider");
// Isolated auth store so codex login never overwrites a real ChatGPT-account
// login already present in the user's own ~/.codex.
const CODEX_HOME = path.join(os.tmpdir(), "cli-ck-bench-codex-home");
const GOOSE_SESSIONS_DB = path.join(os.homedir(), ".local/share/goose/sessions/sessions.db");

const PROVIDER_ENV_VAR = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" };
const PROVIDER_DEFAULT_MODEL = { anthropic: "claude-sonnet-5", openai: "gpt-5.4-mini" };
const ALL_COMPETITORS = ["oz", "codex", "goose", "opencode", "aider"];
// Every successful run in this suite finishes well under 60s; 3 minutes is
// generous headroom. Kept short (rather than 10min) so a genuine hang costs
// one retry's worth of wall-clock, not twenty.
const TOOL_TIMEOUT_MS = 3 * 60 * 1000;

const { values } = parseArgs({
  options: {
    tool: { type: "string", default: "both" },
    competitor: { type: "string", default: "codex,goose,opencode,aider" },
    provider: { type: "string", default: "anthropic" },
    model: { type: "string" },
    tasks: { type: "string" },
  },
});
values.model ??= PROVIDER_DEFAULT_MODEL[values.provider] ?? "claude-sonnet-5";

const taskIds = values.tasks ? new Set(values.tasks.split(",")) : null;
const tasks = taskIds ? TASKS.filter((t) => taskIds.has(t.id)) : TASKS;
const runCliCk = values.tool === "both" || values.tool === "cli-ck";
const requestedCompetitors = new Set(values.competitor.split(",").map((s) => s.trim()).filter(Boolean));
const activeCompetitors =
  values.tool === "both" ? ALL_COMPETITORS.filter((c) => requestedCompetitors.has(c)) : ALL_COMPETITORS.filter((c) => c === values.tool);
const runOz = activeCompetitors.includes("oz");
const runCodex = activeCompetitors.includes("codex");
const runGoose = activeCompetitors.includes("goose");
const runOpencode = activeCompetitors.includes("opencode");
const runAider = activeCompetitors.includes("aider");

const cliCkApiKeyEnv = PROVIDER_ENV_VAR[values.provider] ?? `${values.provider.toUpperCase()}_API_KEY`;
if (runCliCk && !process.env[cliCkApiKeyEnv]) {
  console.error(`${cliCkApiKeyEnv} is required to benchmark cli-ck with provider "${values.provider}". Set it and re-run.`);
  process.exit(1);
}
if (runOz && !process.env.WARP_API_KEY) {
  console.error("WARP_API_KEY is required to benchmark oz. Set it and re-run.");
  process.exit(1);
}
if ((runCodex || runGoose || runOpencode || runAider) && !process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is required to benchmark codex/goose/opencode/aider. Set it and re-run.");
  process.exit(1);
}

async function ensureCodexAuth() {
  const authFile = path.join(CODEX_HOME, "auth.json");
  try {
    await fsp.access(authFile);
    return;
  } catch {}
  await fsp.mkdir(CODEX_HOME, { recursive: true });
  execFileSync("codex", ["login", "--with-api-key"], {
    env: { ...process.env, CODEX_HOME },
    input: process.env.OPENAI_API_KEY,
  });
}

async function seedScratchRepo(task, label) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `cli-ck-bench-${task.id}-${label}-`));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "bench@cli-ck.dev"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "cli-ck bench"], { cwd: dir });
  await task.seed(dir);
  // A HEAD-less repo (no commits yet) breaks opencode's internal git-based
  // checkpoint system — it wipes the working tree back to nothing on its
  // first snapshot. --allow-empty covers seed()s that create no files.
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "seed", "--allow-empty"], { cwd: dir });
  return dir;
}

async function runCliCkAgent(task, dir) {
  const startedAt = performance.now();
  try {
    const { stdout } = await execFileP(
      "node",
      [
        path.join(__dirname, "run.mjs"),
        "--prompt",
        task.prompt,
        "--cwd",
        dir,
        "--provider",
        values.provider,
        "--model",
        values.model,
      ],
      { cwd: repoRoot, timeout: TOOL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
    );
    const wallMs = Math.round(performance.now() - startedAt);
    const parsed = JSON.parse(stdout);
    return { ok: true, wallMs, reported: parsed };
  } catch (e) {
    return { ok: false, wallMs: Math.round(performance.now() - startedAt), error: String(e.message ?? e), killed: e?.killed === true };
  }
}

async function runOzAgent(task, dir) {
  const startedAt = performance.now();
  try {
    const { stdout } = await execFileP(
      OZ_BIN,
      ["agent", "run", "--prompt", task.prompt, "--cwd", dir, "--model", values.model, "--output-format", "json"],
      { timeout: TOOL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
    );
    const wallMs = Math.round(performance.now() - startedAt);
    // ponytail: exact oz JSON shape unconfirmed until a real run — best-effort
    // parse, falls back to raw text if it isn't valid JSON.
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      parsed = { raw: stdout.slice(0, 4000) };
    }
    return { ok: true, wallMs, reported: parsed };
  } catch (e) {
    return { ok: false, wallMs: Math.round(performance.now() - startedAt), error: String(e.message ?? e), killed: e?.killed === true };
  }
}

// execFile's stdin defaults to an open, unconnected pipe — codex exec then
// blocks waiting for it to close (it checks whether stdin is "piped" to
// decide whether to also read instructions from it). spawn() lets us set
// stdio: ["ignore", ...] so the child sees stdin as closed immediately.
function runCodexExec(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", args, {
      env: { ...process.env, CODEX_HOME },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: TOOL_TIMEOUT_MS,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve(stdout);
      else {
        const err = new Error(`codex exec exited ${code}: ${stderr.slice(-2000)}`);
        err.killed = signal != null;
        reject(err);
      }
    });
  });
}

async function runCodexAgent(task, dir) {
  const startedAt = performance.now();
  try {
    const stdout = await runCodexExec([
      "exec",
      "--cd",
      dir,
      "--model",
      values.model,
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "--json",
      task.prompt,
    ]);
    const wallMs = Math.round(performance.now() - startedAt);
    const events = stdout
      .trim()
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const failed = events.find((e) => e.type === "turn.failed");
    if (failed) return { ok: false, wallMs, error: JSON.stringify(failed.error) };
    const completed = events.find((e) => e.type === "turn.completed");
    return { ok: true, wallMs, reported: { usage: completed?.usage ?? null, eventCount: events.length } };
  } catch (e) {
    return { ok: false, wallMs: Math.round(performance.now() - startedAt), error: String(e.message ?? e), killed: e?.killed === true };
  }
}

// Token usage lives in goose's own sqlite session store, keyed by cwd — not
// in run.mjs's stdout — so look up the most recent session for `dir` after
// the run completes.
async function queryGooseUsage(dir) {
  try {
    // goose stores cwd canonicalized (/private/var/... on macOS), but
    // os.tmpdir() gives the symlinked /var/... form — resolve first or the
    // lookup silently matches zero rows.
    const realDir = await fsp.realpath(dir);
    const { stdout } = await execFileP("sqlite3", [
      GOOSE_SESSIONS_DB,
      "-json",
      `select total_tokens, input_tokens, output_tokens from sessions where working_dir = '${realDir.replace(/'/g, "''")}' order by updated_at desc limit 1;`,
    ]);
    const rows = JSON.parse(stdout || "[]");
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

async function runGooseAgent(task, dir) {
  const startedAt = performance.now();
  try {
    await execFileP(
      "goose",
      ["run", "--provider", "openai", "--model", values.model, "--with-builtin", "developer", "-t", task.prompt],
      { cwd: dir, timeout: TOOL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
    );
    const wallMs = Math.round(performance.now() - startedAt);
    return { ok: true, wallMs, reported: await queryGooseUsage(dir) };
  } catch (e) {
    return { ok: false, wallMs: Math.round(performance.now() - startedAt), error: String(e.message ?? e), killed: e?.killed === true };
  }
}

// Same stdin gotcha as codex (see runCodexExec above): execFile's default
// open, unconnected stdin pipe makes opencode hang indefinitely — it must be
// waiting to see if more input is coming. spawn() with stdio: ["ignore", ...]
// closes stdin immediately so it doesn't.
function runOpencodeExec(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("opencode", args, {
      cwd,
      // spawn's cwd option changes the child's real working directory but
      // does NOT update the inherited PWD env var — opencode resolves its
      // project/session identity from PWD, not the syscall cwd, so without
      // this every invocation gets attributed to wherever this harness
      // process itself started and they all bleed into one shared session.
      env: { ...process.env, PWD: cwd },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: TOOL_TIMEOUT_MS,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve(stdout);
      else {
        const err = new Error(`opencode run exited ${code}: ${stderr.slice(-2000)}`);
        err.killed = signal != null;
        reject(err);
      }
    });
  });
}

async function runOpencodeAgent(task, dir) {
  const startedAt = performance.now();
  try {
    const stdout = await runOpencodeExec(["run", "-m", `openai/${values.model}`, "--format", "json", task.prompt], dir);
    const wallMs = Math.round(performance.now() - startedAt);
    const events = stdout
      .trim()
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    // Each step_finish event's tokens.total already includes cache reads
    // (total === input + output + cache.read), matching how codex bundles
    // cached tokens into input_tokens rather than reporting them separately.
    const totalTokens = events.filter((e) => e.type === "step_finish").reduce((sum, e) => sum + (e.part?.tokens?.total ?? 0), 0);
    return { ok: true, wallMs, reported: { total_tokens: totalTokens, eventCount: events.length } };
  } catch (e) {
    return { ok: false, wallMs: Math.round(performance.now() - startedAt), error: String(e.message ?? e), killed: e?.killed === true };
  }
}

async function runAiderAgent(task, dir) {
  const startedAt = performance.now();
  try {
    const { stdout } = await execFileP(
      AIDER_BIN,
      ["--model", values.model, "--yes-always", "--no-check-update", "--no-stream", "--message", task.prompt],
      { cwd: dir, timeout: TOOL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
    );
    const wallMs = Math.round(performance.now() - startedAt);
    // aider abbreviates large counts as "1.0k" — plain [\d,]+ silently
    // fails to match those lines at all, undercounting to zero.
    const parseAiderCount = (s) => (s.endsWith("k") ? Math.round(parseFloat(s) * 1000) : Number(s.replace(/,/g, "")));
    const totalTokens = [...stdout.matchAll(/Tokens: ([\d,.]+k?) sent, ([\d,.]+k?) received/g)].reduce(
      (sum, m) => sum + parseAiderCount(m[1]) + parseAiderCount(m[2]),
      0,
    );
    return { ok: true, wallMs, reported: { total_tokens: totalTokens } };
  } catch (e) {
    return { ok: false, wallMs: Math.round(performance.now() - startedAt), error: String(e.message ?? e), killed: e?.killed === true };
  }
}

if (runCodex) await ensureCodexAuth();

const COMPETITOR_RUNNERS = {
  oz: runOzAgent,
  codex: runCodexAgent,
  goose: runGooseAgent,
  opencode: runOpencodeAgent,
  aider: runAiderAgent,
};

// A killed run means our own timeout fired (process hang/network stall), not
// a real model failure — retry once against a fresh scratch dir rather than
// recording an infra hiccup as a loss. Genuine failures (bad code, wrong
// output) are never retried — they're the signal we're measuring.
async function runWithTimeoutRetry(name, run, task, dir, reseed) {
  let result = await run(task, dir);
  if (!result.ok && result.killed) {
    console.error(`${name}: timed out, retrying once...`);
    dir = await reseed();
    result = await run(task, dir);
  }
  return { result, dir };
}

const results = [];

for (const task of tasks) {
  console.error(`\n=== ${task.id} ===`);
  if (runCliCk) {
    let dir = await seedScratchRepo(task, "cli-ck");
    console.error(`cli-ck: running in ${dir}`);
    const { result: run, dir: finalDir } = await runWithTimeoutRetry("cli-ck", runCliCkAgent, task, dir, () => seedScratchRepo(task, "cli-ck"));
    const verdict = run.ok ? task.verify(finalDir) : { pass: false, detail: run.error };
    results.push({ task: task.id, tool: "cli-ck", ...run, ...verdict });
    console.error(`cli-ck: ${run.wallMs}ms, pass=${verdict.pass}`);
  }
  for (const name of activeCompetitors) {
    let dir = await seedScratchRepo(task, name);
    console.error(`${name}: running in ${dir}`);
    const { result: run, dir: finalDir } = await runWithTimeoutRetry(name, COMPETITOR_RUNNERS[name], task, dir, () => seedScratchRepo(task, name));
    const verdict = run.ok ? task.verify(finalDir) : { pass: false, detail: run.error };
    results.push({ task: task.id, tool: name, ...run, ...verdict });
    console.error(`${name}: ${run.wallMs}ms, pass=${verdict.pass}`);
  }
}

console.log(JSON.stringify(results, null, 2));

const failed = results.filter((r) => !r.pass);
if (failed.length) {
  console.error(`\n${failed.length}/${results.length} runs failed verification.`);
  process.exitCode = 1;
}
