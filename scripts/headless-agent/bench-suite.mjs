#!/usr/bin/env node
/**
 * Runs the task suite in bench-tasks.mjs against both cli-ck's headless
 * agent (run.mjs) and Warp's `oz agent run`, on freshly seeded scratch
 * repos, and reports wall-clock time + pass/fail per task per tool.
 *
 * Requires:
 *   ANTHROPIC_API_KEY  — for cli-ck's agent
 *   WARP_API_KEY       — for oz
 *
 * Usage:
 *   node scripts/headless-agent/bench-suite.mjs [--tool cli-ck|oz|both] [--model claude-sonnet-5] [--tasks id1,id2]
 */
import { execFile, execFileSync } from "node:child_process";
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

const { values } = parseArgs({
  options: {
    tool: { type: "string", default: "both" },
    model: { type: "string", default: "claude-sonnet-5" },
    tasks: { type: "string" },
  },
});

const taskIds = values.tasks ? new Set(values.tasks.split(",")) : null;
const tasks = taskIds ? TASKS.filter((t) => taskIds.has(t.id)) : TASKS;
const runCliCk = values.tool === "both" || values.tool === "cli-ck";
const runOz = values.tool === "both" || values.tool === "oz";

if (runCliCk && !process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is required to benchmark cli-ck. Set it and re-run.");
  process.exit(1);
}
if (runOz && !process.env.WARP_API_KEY) {
  console.error("WARP_API_KEY is required to benchmark oz. Set it and re-run.");
  process.exit(1);
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
        "anthropic",
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
}

console.log(JSON.stringify(results, null, 2));

const failed = results.filter((r) => !r.pass);
if (failed.length) {
  console.error(`\n${failed.length}/${results.length} runs failed verification.`);
  process.exitCode = 1;
}
