// Self-check for tauriInvokeShim.ts, run without an LLM key: exercises the
// fs/shell command handlers directly against a scratch temp dir, mirroring
// what the fs/edit/shell tool files actually call through native.ts.
//
//   node --experimental-strip-types scripts/headless-agent/tauriInvokeShim.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { invoke } from "./tauriInvokeShim.ts";

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "cli-ck-shim-test-"));
execFileSync("git", ["init", "-q"], { cwd: dir });

const filePath = path.join(dir, "hello.txt");
await invoke("fs_write_file", { path: filePath, content: "hello world\n" });

const read = await invoke("fs_read_file", { path: filePath });
assert.equal(read.kind, "text");
assert.equal(read.content, "hello world\n");
console.log("ok: fs_write_file + fs_read_file round-trip");

const grep = await invoke("fs_grep", { pattern: "hello", root: dir });
assert.equal(grep.hits.length, 1);
assert.equal(grep.hits[0].rel, "hello.txt");
console.log("ok: fs_grep finds the known string");

const glob = await invoke("fs_glob", { pattern: "*.txt", root: dir });
assert.ok(glob.hits.some((h) => h.rel === "hello.txt"));
console.log("ok: fs_glob matches the file");

const dirList = await invoke("fs_read_dir", { path: dir });
assert.ok(dirList.some((e) => e.name === "hello.txt" && e.kind === "file"));
console.log("ok: fs_read_dir lists the file");

const shell = await invoke("shell_run_command", { command: "echo hello" });
assert.equal(shell.stdout.trim(), "hello");
assert.equal(shell.exit_code, 0);
console.log("ok: shell_run_command captures stdout");

const sessionId = await invoke("shell_session_open", { cwd: dir });
await invoke("shell_session_run", { id: sessionId, command: "mkdir sub && cd sub" });
const afterCd = await invoke("shell_session_run", { id: sessionId, command: "pwd" });
assert.equal(afterCd.stdout.trim(), path.join(await fsp.realpath(dir), "sub"));
console.log("ok: shell session persists cwd across cd");

await fsp.rm(dir, { recursive: true, force: true });
console.log("\nall checks passed");
