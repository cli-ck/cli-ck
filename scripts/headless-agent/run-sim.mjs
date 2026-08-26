#!/usr/bin/env node
/**
 * Simulation variant of run.mjs: same real agent code path (real tools,
 * real streamText call), but with three deliberate deltas being tested:
 *   1. SYSTEM_PROMPT_LITE instead of the full SYSTEM_PROMPT.
 *   2. Trimmed toolbox: only read_file, write_file, edit, multi_edit
 *      (dropping list_directory, create_directory, grep, glob, 5 shell
 *      tools, subagent, terminal, todo, managed-agent tools).
 *   3. read-before-edit invariant pre-satisfied (readCache pre-seeded for
 *      every file that exists at task start) + a prepareStep hook that
 *      truncates old tool-result content once 2+ newer steps exist.
 * No Lever B (no single-shot mode) — this still runs the real multi-step
 * tool-calling loop, so a genuine self-correction loop (like dedup-refactor
 * hit before) is free to happen and be measured, not hidden.
 */
import { parseArgs } from "node:util";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { streamText, stepCountIs } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

const { values } = parseArgs({
  options: {
    prompt: { type: "string" },
    cwd: { type: "string" },
    model: { type: "string", default: "gpt-4o-mini" },
  },
});

if (!values.prompt || !values.cwd) {
  console.error("Usage: node run-sim.mjs --prompt <task> --cwd <dir> [--model id]");
  process.exit(1);
}

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("No OPENAI_API_KEY set.");
  process.exit(1);
}
const cwd = path.resolve(values.cwd);

const server = await createServer({
  root: repoRoot,
  configFile: false,
  logLevel: "warn",
  plugins: [
    {
      name: "stub-css",
      enforce: "pre",
      resolveId(id) {
        if (id.endsWith(".css")) return `\0stub-css:${encodeURIComponent(id)}.js`;
      },
      load(id) {
        if (id.startsWith("\0stub-css:")) return "export default {};";
      },
    },
  ],
  resolve: {
    alias: [
      { find: "@tauri-apps/api/core", replacement: path.join(__dirname, "tauriInvokeShim.ts") },
      { find: /^@\/features\/shell-pty\/terminal$/, replacement: path.join(__dirname, "shellPtyTerminalStub.ts") },
      { find: "@", replacement: path.join(repoRoot, "src") },
    ],
  },
});

// Truncate old tool-result content once 2+ newer tool-result messages exist
// after it — simulates "don't keep re-paying for stale file contents every
// step" without touching the real tool implementations.
function pruneHistory(messages) {
  const toolMsgIdx = [];
  messages.forEach((m, i) => { if (m.role === "tool") toolMsgIdx.push(i); });
  const keepFrom = toolMsgIdx.length > 2 ? toolMsgIdx[toolMsgIdx.length - 2] : -1;
  return messages.map((m, i) => {
    if (m.role !== "tool" || i >= keepFrom) return m;
    if (!Array.isArray(m.content)) return m;
    return {
      ...m,
      content: m.content.map((part) => {
        if (part.type !== "tool-result") return part;
        const out = part.output;
        const val = out && typeof out === "object" && "value" in out ? out.value : out;
        if (val && typeof val === "object" && typeof val.content === "string" && val.content.length > 200) {
          const trimmedVal = { ...val, content: "[omitted — superseded by a later step]" };
          const trimmedOut = out && typeof out === "object" && "value" in out ? { ...out, value: trimmedVal } : trimmedVal;
          return { ...part, output: trimmedOut };
        }
        return part;
      }),
    };
  });
}

try {
  const { buildFsTools } = await server.ssrLoadModule(path.join(repoRoot, "src/features/ai-companion/ai/tools/fs.ts"));
  const { buildEditTools } = await server.ssrLoadModule(path.join(repoRoot, "src/features/ai-companion/ai/tools/edit.ts"));
  const { buildShellTools } = await server.ssrLoadModule(path.join(repoRoot, "src/features/ai-companion/ai/tools/shell.ts"));
  const { SYSTEM_PROMPT_LITE } = await server.ssrLoadModule(path.join(repoRoot, "src/features/ai-companion/ai/config.ts"));

  const readCache = new Map();
  // Pre-seed the read-before-edit invariant for every file that already
  // exists at task start — simulates skipping the mandatory separate
  // read_file call for existing-file edits (Fix 2), via real tool code.
  const entries = await fsp.readdir(cwd, { withFileTypes: true });
  for (const e of entries) {
    if (e.isFile() && !e.name.startsWith(".")) {
      readCache.set(path.join(cwd, e.name), { size: 0, hash: 0 });
    }
  }

  const toolContext = { getCwd: () => cwd, readCache, getSessionId: () => "sim-" + path.basename(cwd) };
  const allFs = buildFsTools(toolContext);
  const allEdit = buildEditTools(toolContext);
  const allShell = buildShellTools(toolContext);
  // Fix 6 (tested against Fix 5's regression, see notes below): a 5th tool,
  // bash_run, restores the model's ability to verify its own fix instead of
  // guessing. Gated so we can A/B it against the 4-tool version.
  const rawTools = {
    read_file: allFs.read_file,
    write_file: allFs.write_file,
    edit: allEdit.edit,
    multi_edit: allEdit.multi_edit,
    ...(process.env.WITH_BASH ? { bash_run: allShell.bash_run } : {}),
  };

  // Fix 5: code-level guardrails, not prompt text. Prompt-only "tool
  // discipline" wording was tested live and was unreliable (3 reruns of
  // fix-off-by-one gave 4, 14, and 6 steps, still violating the excluded
  // file 2/3 times). These two guards make the two wasted round-trips
  // structurally impossible instead of hoping the model reads the prompt:
  //   A. Protected-file guard: block edit/write/multi_edit on any file the
  //      task prompt explicitly says not to change.
  //   B. Redundant-write guard: once a file has been `edit`ed this task,
  //      block `write_file` on that same file — forces follow-up changes
  //      through `edit` instead of a wasted full-file rewrite.
  function protectedFilesFromPrompt(prompt) {
    const set = new Set();
    const re = /do not change ([a-zA-Z0-9_\-./]+\.\w+)/gi;
    let m;
    while ((m = re.exec(prompt))) set.add(path.basename(m[1]));
    return set;
  }
  const protectedFiles = protectedFilesFromPrompt(values.prompt);
  const editedThisTask = new Set();
  function resolveAbs(p) {
    return path.isAbsolute(p) ? p : path.join(cwd, p);
  }
  function guardResult(message) {
    return { unchanged: false, error: message };
  }

  const tools = { ...rawTools };
  if (protectedFiles.size > 0 && tools.edit) {
    const orig = tools.edit.execute;
    tools.edit = { ...tools.edit, execute: async (input, opts) => {
      if (protectedFiles.has(path.basename(input.path))) {
        return guardResult(`Blocked: ${input.path} is protected — the task says not to change this file.`);
      }
      const res = await orig(input, opts);
      editedThisTask.add(resolveAbs(input.path));
      return res;
    } };
  } else if (tools.edit) {
    const orig = tools.edit.execute;
    tools.edit = { ...tools.edit, execute: async (input, opts) => {
      const res = await orig(input, opts);
      editedThisTask.add(resolveAbs(input.path));
      return res;
    } };
  }
  if (tools.multi_edit) {
    const orig = tools.multi_edit.execute;
    tools.multi_edit = { ...tools.multi_edit, execute: async (input, opts) => {
      if (protectedFiles.has(path.basename(input.path))) {
        return guardResult(`Blocked: ${input.path} is protected — the task says not to change this file.`);
      }
      const res = await orig(input, opts);
      editedThisTask.add(resolveAbs(input.path));
      return res;
    } };
  }
  if (tools.write_file) {
    const orig = tools.write_file.execute;
    tools.write_file = { ...tools.write_file, execute: async (input, opts) => {
      if (protectedFiles.has(path.basename(input.path))) {
        return guardResult(`Blocked: ${input.path} is protected — the task says not to change this file.`);
      }
      // NOTE: redundant-write blocking (write_file after edit on same path)
      // was tried and reverted — it made things worse (see run-sim notes).
      // Blocking the model's fallback move without giving it another way to
      // resolve uncertainty just made it thrash across other tools instead.
      return orig(input, opts);
    } };
  }

  const openai = createOpenAI({ apiKey });
  const model = openai(values.model);
  // Fix 6b: bash_run alone made things worse in 1/2 runs — the model
  // defaulted to `npm test`/jest and spiraled trying to scaffold a test
  // runner that isn't there. One concrete verification hint (not broad
  // "tool discipline" prose, which already failed) targets that exact
  // failure mode.
  const VERIFY_HINT = process.env.WITH_BASH
    ? "\n\nTo verify a fix, run the relevant file directly with `node <file>` via bash_run. Do not assume npm, jest, or a test framework is set up — check for package.json first if unsure."
    : "";
  const system = SYSTEM_PROMPT_LITE + VERIFY_HINT;

  const startedAt = performance.now();
  const result = await streamText({
    model,
    system,
    messages: [{ role: "user", content: values.prompt }],
    tools,
    stopWhen: stepCountIs(24),
    toolApproval: () => "approved",
    prepareStep: ({ messages }) => ({ messages: pruneHistory(messages) }),
  });

  const [finalText, usage, finishReason, steps] = await Promise.all([
    result.text,
    result.usage,
    result.finishReason,
    result.steps,
  ]);
  const durationMs = Math.round(performance.now() - startedAt);
  const toolCallCount = steps.reduce((n, s) => n + (s.toolCalls?.length ?? 0), 0);

  if (process.env.DEBUG_STEPS) {
    steps.forEach((s, i) => {
      const calls = (s.toolCalls ?? []).map((c) => {
        const a = c.input ?? c.args ?? {};
        const brief = a.path ? `${a.path}${a.old_string ? ` old="${String(a.old_string).slice(0, 40)}"` : ""}${a.edits ? ` edits=${a.edits.length}` : ""}` : JSON.stringify(a).slice(0, 60);
        return `${c.toolName}(${brief})`;
      });
      console.error(`step ${i + 1}: ${calls.join(", ") || "(text only)"}`);
    });
  }

  console.log(
    JSON.stringify(
      {
        prompt: values.prompt,
        model: values.model,
        durationMs,
        stepCount: steps.length,
        toolCallCount,
        finishReason,
        inputTokens: usage.inputTokens ?? null,
        outputTokens: usage.outputTokens ?? null,
        finalText,
      },
      null,
      2,
    ),
  );
  process.exitCode = 0;
} catch (err) {
  console.error(err?.stack ?? String(err));
  process.exitCode = 1;
} finally {
  await server.close();
}
