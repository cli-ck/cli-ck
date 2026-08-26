#!/usr/bin/env node
// Driver for run-sim-b.mjs (Lever B: single-shot, tool-free) across the same
// 5 TASKS used in the real benchmark.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { TASKS } from "./bench-tasks.mjs";

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Which existing files (if any) need to be inlined into the prompt for each
// task, since there's no read_file tool call to fetch them anymore.
const FILES_BY_TASK = {
  "pure-function": [],
  "fix-off-by-one": ["range.js"],
  "dedup-refactor": ["stats.js"],
  "boundary-error-handling": ["divide.js"],
  "cli-arg-parser": [],
};

async function seedScratchRepo(task) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `cli-ck-simb-${task.id}-`));
  await task.seed(dir);
  return dir;
}

const results = [];
for (const task of TASKS) {
  const dir = await seedScratchRepo(task);
  const files = FILES_BY_TASK[task.id] ?? [];
  console.error(`\n=== ${task.id} === running in ${dir}`);
  try {
    const args = [
      path.join(__dirname, "run-sim-b.mjs"),
      "--prompt", task.prompt,
      "--cwd", dir,
      "--model", "gpt-4o-mini",
    ];
    if (files.length) args.push("--files", files.join(","));
    const { stdout } = await execFileP("node", args, {
      timeout: 3 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env },
    });
    const reported = JSON.parse(stdout);
    const verdict = task.verify(dir);
    results.push({ task: task.id, tool: "cli-ck-simB", ok: true, reported, ...verdict });
    console.error(`${task.id}: input=${reported.inputTokens} output=${reported.outputTokens} filesWritten=${JSON.stringify(reported.filesWritten)} pass=${verdict.pass}`);
  } catch (e) {
    console.error(`${task.id}: FAILED — ${e.message}`);
    results.push({ task: task.id, tool: "cli-ck-simB", ok: false, error: String(e.message ?? e) });
  }
}

console.log(JSON.stringify(results, null, 2));
