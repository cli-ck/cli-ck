#!/usr/bin/env node
/**
 * Lever B: single-shot, tool-free mode — architecturally matches Aider's
 * default whole-file coder (confirmed via _research_refs/aider read earlier,
 * and via Context7 /vercel/ai docs: generateText with no `tools` param sends
 * zero tool-schema overhead). One API call: existing file contents (if any)
 * are inlined directly into the user message by the harness (plain fs read,
 * no tool round-trip), the model returns full file contents in a fenced
 * block per file, the harness writes them with plain fs (no tool round-trip
 * on the way out either). No agent loop, no self-verification step.
 */
import { parseArgs } from "node:util";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

const { values } = parseArgs({
  options: {
    prompt: { type: "string" },
    cwd: { type: "string" },
    model: { type: "string", default: "gpt-4o-mini" },
    files: { type: "string", default: "" }, // comma-separated existing files to inline
  },
});

if (!values.prompt || !values.cwd) {
  console.error("Usage: node run-sim-b.mjs --prompt <task> --cwd <dir> [--files a.js,b.js] [--model id]");
  process.exit(1);
}

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("No OPENAI_API_KEY set.");
  process.exit(1);
}
const cwd = path.resolve(values.cwd);

const SYSTEM = [
  "You are an expert coder. You will receive a task and, if relevant, the",
  "current contents of existing files. Reply with ONLY the full contents of",
  "each file that needs to be created or changed, in this exact format, one",
  "block per file, nothing else:",
  "",
  "```file:range.js",
  "...full file contents...",
  "```",
  "",
  "The text right after `file:` must be the real relative file path named in",
  "the task or in the existing file contents shown to you (e.g. `range.js`,",
  "`math.test.js`) — never a placeholder like `path/to/file.js`.",
  "Include a complete block for every file the task requires (new or",
  "changed). Do not include explanations, markdown prose, or partial diffs.",
].join("\n");

const fileNames = values.files ? values.files.split(",").filter(Boolean) : [];
let userContent = values.prompt;
for (const f of fileNames) {
  const content = await fsp.readFile(path.join(cwd, f), "utf8");
  userContent += `\n\nCurrent contents of ${f}:\n\`\`\`\n${content}\`\`\``;
}

function parseFileBlocks(text) {
  const re = /```file:([^\n]+)\n([\s\S]*?)```/g;
  const files = [];
  let m;
  while ((m = re.exec(text))) files.push({ path: m[1].trim(), content: m[2] });
  return files;
}

const openai = createOpenAI({ apiKey });
const model = openai(values.model);

const startedAt = performance.now();
const result = await generateText({
  model,
  system: SYSTEM,
  prompt: userContent,
});
const durationMs = Math.round(performance.now() - startedAt);

const files = parseFileBlocks(result.text);
const written = [];
for (const f of files) {
  try {
    await fsp.mkdir(path.dirname(path.join(cwd, f.path)), { recursive: true });
    await fsp.writeFile(path.join(cwd, f.path), f.content);
    written.push(f.path);
  } catch (e) {
    console.error(`skip write for "${f.path}": ${e.message}`);
  }
}

console.log(
  JSON.stringify(
    {
      prompt: values.prompt,
      model: values.model,
      durationMs,
      stepCount: 1,
      toolCallCount: 0,
      finishReason: result.finishReason,
      inputTokens: result.usage.inputTokens ?? null,
      outputTokens: result.usage.outputTokens ?? null,
      filesWritten: written,
      finalText: result.text,
    },
    null,
    2,
  ),
);
