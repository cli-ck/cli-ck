// Five small, deterministically-gradable coding tasks used to compare
// cli-ck's headless agent against Warp's `oz agent run`. Each task seeds a
// scratch git repo and exposes a verify() that runs the produced code with
// plain `node` (no package installs, so grading time never mixes with agent
// time) and reports pass/fail by exit code.
import { execFileSync } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

function write(dir, file, content) {
  return fsp.writeFile(path.join(dir, file), content);
}

function verifyNode(file) {
  return (dir) => {
    try {
      execFileSync("node", [file], { cwd: dir, stdio: "pipe", timeout: 15_000 });
      return { pass: true };
    } catch (e) {
      return { pass: false, detail: (e.stderr ?? e.message ?? String(e)).toString().slice(0, 2000) };
    }
  };
}

export const TASKS = [
  {
    id: "pure-function",
    prompt:
      "Create a file `math.js` (CommonJS, `module.exports`) exporting a function `factorial(n)` " +
      "that returns n! (factorial(0) === 1). Also create `math.test.js` that requires math.js, " +
      "uses node's built-in `assert` module to check factorial(5) === 120, and exits 0 on success.",
    async seed() {},
    verify: verifyNode("math.test.js"),
  },
  {
    id: "fix-off-by-one",
    prompt:
      "The test in range.test.js is failing. Fix the bug in range.js so the test passes. " +
      "Do not change range.test.js.",
    async seed(dir) {
      await write(
        dir,
        "range.js",
        "// sumRange(a, b) should return the sum of all integers from a to b, inclusive.\n" +
          "function sumRange(a, b) {\n" +
          "  let s = 0;\n" +
          "  for (let i = a; i < b; i++) s += i;\n" +
          "  return s;\n" +
          "}\n" +
          "module.exports = { sumRange };\n",
      );
      await write(
        dir,
        "range.test.js",
        "const assert = require('node:assert');\n" +
          "const { sumRange } = require('./range.js');\n" +
          "assert.strictEqual(sumRange(1, 5), 15);\n" +
          "console.log('ok');\n",
      );
    },
    verify: verifyNode("range.test.js"),
  },
  {
    id: "dedup-refactor",
    prompt:
      "Refactor stats.js to remove the duplicated averaging logic between averageOfEvens and " +
      "averageOfOdds by extracting a shared helper function, without changing behavior. " +
      "Do not change stats.test.js.",
    async seed(dir) {
      await write(
        dir,
        "stats.js",
        "function averageOfEvens(nums) {\n" +
          "  const filtered = nums.filter((n) => n % 2 === 0);\n" +
          "  const sum = filtered.reduce((a, b) => a + b, 0);\n" +
          "  return filtered.length ? sum / filtered.length : 0;\n" +
          "}\n" +
          "function averageOfOdds(nums) {\n" +
          "  const filtered = nums.filter((n) => n % 2 !== 0);\n" +
          "  const sum = filtered.reduce((a, b) => a + b, 0);\n" +
          "  return filtered.length ? sum / filtered.length : 0;\n" +
          "}\n" +
          "module.exports = { averageOfEvens, averageOfOdds };\n",
      );
      await write(
        dir,
        "stats.test.js",
        "const assert = require('node:assert');\n" +
          "const { averageOfEvens, averageOfOdds } = require('./stats.js');\n" +
          "assert.strictEqual(averageOfEvens([1, 2, 3, 4, 5, 6]), 4);\n" +
          "assert.strictEqual(averageOfOdds([1, 2, 3, 4, 5, 6]), 3);\n" +
          "console.log('ok');\n",
      );
    },
    verify: verifyNode("stats.test.js"),
  },
  {
    id: "boundary-error-handling",
    prompt:
      "The test in divide.test.js is failing. Update divide.js so dividing by zero throws an " +
      "Error with message 'Division by zero', while all other divisions still work as before. " +
      "Do not change divide.test.js.",
    async seed(dir) {
      await write(
        dir,
        "divide.js",
        "function safeDivide(a, b) {\n  return a / b;\n}\nmodule.exports = { safeDivide };\n",
      );
      await write(
        dir,
        "divide.test.js",
        "const assert = require('node:assert');\n" +
          "const { safeDivide } = require('./divide.js');\n" +
          "assert.strictEqual(safeDivide(10, 2), 5);\n" +
          "assert.throws(() => safeDivide(10, 0), /Division by zero/);\n" +
          "console.log('ok');\n",
      );
    },
    verify: verifyNode("divide.test.js"),
  },
  {
    id: "cli-arg-parser",
    prompt:
      "Create a file `parse-args.js` (CommonJS, `module.exports`) exporting a function " +
      "`parseArgs(argv)` that parses `--key value` pairs and standalone `--flag` boolean flags " +
      "from an array into an object, e.g. parseArgs(['--name','Ann','--verbose']) returns " +
      "{name: 'Ann', verbose: true}. Create parse-args.test.js that requires it, asserts on that " +
      "example with node's assert module, and exits 0 on success.",
    async seed() {},
    verify: verifyNode("parse-args.test.js"),
  },
];
