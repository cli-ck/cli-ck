// Self-check for bench-tasks.mjs: for each task, applies a known-correct
// solution and confirms verify() passes, and (for the bug-fix tasks) that
// the unmodified seed fails verify() — i.e. the test actually tests
// something, not just "file exists".
//
//   node scripts/headless-agent/bench-tasks.check.mjs
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { TASKS } from "./bench-tasks.mjs";

async function scratchDir(id) {
  return fsp.mkdtemp(path.join(os.tmpdir(), `cli-ck-bench-task-test-${id}-`));
}

function write(dir, file, content) {
  return fsp.writeFile(path.join(dir, file), content);
}

const solutions = {
  "pure-function": async (dir) => {
    await write(
      dir,
      "math.js",
      "function factorial(n) { return n <= 1 ? 1 : n * factorial(n - 1); }\nmodule.exports = { factorial };\n",
    );
    await write(
      dir,
      "math.test.js",
      "const assert = require('node:assert');\nconst { factorial } = require('./math.js');\nassert.strictEqual(factorial(5), 120);\nconsole.log('ok');\n",
    );
  },
  "fix-off-by-one": async (dir) => {
    await write(
      dir,
      "range.js",
      "function sumRange(a, b) {\n  let s = 0;\n  for (let i = a; i <= b; i++) s += i;\n  return s;\n}\nmodule.exports = { sumRange };\n",
    );
  },
  "dedup-refactor": async (dir) => {
    await write(
      dir,
      "stats.js",
      "function average(nums, predicate) {\n  const filtered = nums.filter(predicate);\n  const sum = filtered.reduce((a, b) => a + b, 0);\n  return filtered.length ? sum / filtered.length : 0;\n}\n" +
        "function averageOfEvens(nums) { return average(nums, (n) => n % 2 === 0); }\n" +
        "function averageOfOdds(nums) { return average(nums, (n) => n % 2 !== 0); }\n" +
        "module.exports = { averageOfEvens, averageOfOdds };\n",
    );
  },
  "boundary-error-handling": async (dir) => {
    await write(
      dir,
      "divide.js",
      "function safeDivide(a, b) {\n  if (b === 0) throw new Error('Division by zero');\n  return a / b;\n}\nmodule.exports = { safeDivide };\n",
    );
  },
  "cli-arg-parser": async (dir) => {
    await write(
      dir,
      "parse-args.js",
      "function parseArgs(argv) {\n  const out = {};\n  for (let i = 0; i < argv.length; i++) {\n    const a = argv[i];\n    if (!a.startsWith('--')) continue;\n    const key = a.slice(2);\n    const next = argv[i + 1];\n    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }\n    else out[key] = true;\n  }\n  return out;\n}\nmodule.exports = { parseArgs };\n",
    );
    await write(
      dir,
      "parse-args.test.js",
      "const assert = require('node:assert');\nconst { parseArgs } = require('./parse-args.js');\nassert.deepStrictEqual(parseArgs(['--name','Ann','--verbose']), { name: 'Ann', verbose: true });\nconsole.log('ok');\n",
    );
  },
};

for (const task of TASKS) {
  const dir = await scratchDir(task.id);
  await task.seed(dir);

  if (task.id === "fix-off-by-one" || task.id === "boundary-error-handling") {
    const unfixed = task.verify(dir);
    assert.equal(unfixed.pass, false, `${task.id}: seed should fail verify before the fix is applied`);
  }

  await solutions[task.id](dir);
  const fixed = task.verify(dir);
  assert.equal(fixed.pass, true, `${task.id}: known-good solution should pass verify (${fixed.detail ?? ""})`);
  console.log(`ok: ${task.id}`);

  await fsp.rm(dir, { recursive: true, force: true });
}

console.log("\nall checks passed");
