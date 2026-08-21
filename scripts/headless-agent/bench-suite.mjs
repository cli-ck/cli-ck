#!/usr/bin/env node
/**
 * Runs the task suite in bench-tasks.mjs against cli-ck's headless agent
 * (run.mjs) and a competitor CLI — Warp's `oz agent run` or OpenAI's
 * `codex exec` — on freshly seeded scratch repos, and reports wall-clock
 * time + pass/fail per task per tool.
 *
 * Requires:
 *   ANTHROPIC_API_KEY or OPENAI_API_KEY  — for cli-ck's agent (per --provider)
 *   WARP_API_KEY                         — for oz
 *   OPENAI_API_KEY                       — for codex (logs into an isolated
 *                                           CODEX_HOME so it never touches a
 *                                           real ChatGPT-account login)
 *
 * Usage:
 *   node scripts/headless-agent/bench-suite.mjs [--tool cli-ck|oz|codex|both] [--competitor oz|codex] [--model gpt-4o-mini] [--tasks id1,id2]
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

// ponytail: hardcoded to the bundled Oz binary found on this machine at
// /Applications/Warp.app/Contents/Resources/bin/oz. Upgrade to `which oz`
// first if this ever runs on a box with a standalone Oz install instead.
const OZ_BIN = "/Applications/Warp.app/Contents/Resources/bin/oz";
// Isolated auth store so codex login never overwrites a real ChatGPT-account
// login already present in the user's own ~/.codex.
const CODEX_HOME = path.join(os.tmpdir(), "cli-ck-bench-codex-home");

const PROVIDER_ENV_VAR = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" };
const PROVIDER_DEFAULT_MODEL = { anthropic: "claude-sonnet-5", openai: "gpt-5.4-mini" };

const { values } = parseArgs({
  options: {
    tool: { type: "string", default: "both" },
    competitor: { type: "string", default: "codex" },
    provider: { type: "string", default: "anthropic" },
    model: { type: "string" },
    tasks: { type: "string" },
  },
});
values.model ??= PROVIDER_DEFAULT_MODEL[values.provider] ?? "claude-sonnet-5";

const taskIds = values.tasks ? new Set(values.tasks.split(",")) : null;
const tasks = taskIds ? TASKS.filter((t) => taskIds.has(t.id)) : TASKS;
const runCliCk = values.tool === "both" || values.tool === "cli-ck";
const runOz = values.tool === "oz" || (values.tool === "both" && values.competitor === "oz");
const runCodex = values.tool === "codex" || (values.tool === "both" && values.competitor === "codex");

const cliCkApiKeyEnv = PROVIDER_ENV_VAR[values.provider] ?? `${values.provider.toUpperCase()}_API_KEY`;
if (runCliCk && !process.env[cliCkApiKeyEnv]) {
  console.error(`${cliCkApiKeyEnv} is required to benchmark cli-ck with provider "${values.provider}". Set it and re-run.`);
  process.exit(1);
}
if (runOz && !process.env.WARP_API_KEY) {
  console.error("WARP_API_KEY is required to benchmark oz. Set it and re-run.");
  process.exit(1);
}
if (runCodex && !process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is required to benchmark codex. Set it and re-run.");
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
      { cwd: repoRoot, timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 },
    );
    const wallMs = Math.round(performance.now() - startedAt);
    const parsed = JSON.parse(stdout);
    return { ok: true, wallMs, reported: parsed };
  } catch (e) {
    return { ok: false, wallMs: Math.round(performance.now() - startedAt), error: String(e.message ?? e) };
  }
}

async function runOzAgent(task, dir) {
  const startedAt = performance.now();
  try {
    const { stdout } = await execFileP(
      OZ_BIN,
      ["agent", "run", "--prompt", task.prompt, "--cwd", dir, "--model", values.model, "--output-format", "json"],
      { timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 },
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
    return { ok: false, wallMs: Math.round(performance.now() - startedAt), error: String(e.message ?? e) };
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
      timeout: 10 * 60 * 1000,
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
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`codex exec exited ${code}: ${stderr.slice(-2000)}`));
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
    return { ok: false, wallMs: Math.round(performance.now() - startedAt), error: String(e.message ?? e) };
  }
}

if (runCodex) await ensureCodexAuth();

const results = [];

for (const task of tasks) {
  console.error(`\n=== ${task.id} ===`);
  if (runCliCk) {
    const dir = await seedScratchRepo(task, "cli-ck");
    console.error(`cli-ck: running in ${dir}`);
    const run = await runCliCkAgent(task, dir);
    const verdict = run.ok ? task.verify(dir) : { pass: false, detail: run.error };
    results.push({ task: task.id, tool: "cli-ck", ...run, ...verdict });
    console.error(`cli-ck: ${run.wallMs}ms, pass=${verdict.pass}`);
  }
  if (runOz) {
    const dir = await seedScratchRepo(task, "oz");
    console.error(`oz: running in ${dir}`);
    const run = await runOzAgent(task, dir);
    const verdict = run.ok ? task.verify(dir) : { pass: false, detail: run.error };
    results.push({ task: task.id, tool: "oz", ...run, ...verdict });
    console.error(`oz: ${run.wallMs}ms, pass=${verdict.pass}`);
  }
  if (runCodex) {
    const dir = await seedScratchRepo(task, "codex");
    console.error(`codex: running in ${dir}`);
    const run = await runCodexAgent(task, dir);
    const verdict = run.ok ? task.verify(dir) : { pass: false, detail: run.error };
    results.push({ task: task.id, tool: "codex", ...run, ...verdict });
    console.error(`codex: ${run.wallMs}ms, pass=${verdict.pass}`);
  }
}

console.log(JSON.stringify(results, null, 2));

const failed = results.filter((r) => !r.pass);
if (failed.length) {
  console.error(`\n${failed.length}/${results.length} runs failed verification.`);
  process.exitCode = 1;
}
