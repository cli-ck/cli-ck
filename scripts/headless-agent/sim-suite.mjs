#!/usr/bin/env node
// Driver for run-sim.mjs across the same 5 TASKS used in the real benchmark.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { TASKS } from "./bench-tasks.mjs";

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function seedScratchRepo(task) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `cli-ck-sim-${task.id}-`));
  await task.seed(dir);
  return dir;
}

const results = [];
for (const task of TASKS) {
  const dir = await seedScratchRepo(task);
  console.error(`\n=== ${task.id} === running in ${dir}`);
  try {
    const { stdout } = await execFileP(
      "node",
      [path.join(__dirname, "run-sim.mjs"), "--prompt", task.prompt, "--cwd", dir, "--model", "gpt-4o-mini"],
      { timeout: 3 * 60 * 1000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env } },
    );
    const reported = JSON.parse(stdout);
    const verdict = task.verify(dir);
    results.push({ task: task.id, tool: "cli-ck-sim", ok: true, reported, ...verdict });
    console.error(`${task.id}: steps=${reported.stepCount} tools=${reported.toolCallCount} input=${reported.inputTokens} output=${reported.outputTokens} pass=${verdict.pass}`);
  } catch (e) {
    console.error(`${task.id}: FAILED — ${e.message}`);
    results.push({ task: task.id, tool: "cli-ck-sim", ok: false, error: String(e.message ?? e) });
  }
}

console.log(JSON.stringify(results, null, 2));
